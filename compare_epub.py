#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys
import os
import zipfile
import io
import hashlib
import re
import textwrap
from xml.etree import ElementTree as ET


def normalize_path(path: str) -> str:
    if path is None:
        return ''
    # Normalize and convert to POSIX-style separators for stable comparisons
    norm = os.path.normpath(path).replace('\\', '/').strip()
    # Remove any leading './'
    if norm.startswith('./'):
        norm = norm[2:]
    return norm


def zip_namelist_files(z: zipfile.ZipFile):
    names = z.namelist()
    # Exclude directory entries (end with '/')
    return [normalize_path(n) for n in names if not n.endswith('/')]


def read_text_from_zip(z: zipfile.ZipFile, name: str, encoding='utf-8', errors='replace') -> str:
    with z.open(name, 'r') as f:
        data = f.read()
    try:
        return data.decode(encoding, errors=errors)
    except LookupError:
        return data.decode('utf-8', errors='replace')


def get_rootfile_from_container(xml_text: str) -> str | None:
    try:
        doc = ET.fromstring(xml_text)
    except ET.ParseError:
        return None
    # container/rootfiles/rootfile @full-path (or @fullPath)
    rootfiles = doc.findall('.//{*}rootfile')
    if not rootfiles:
        return None
    full = rootfiles[0].get('full-path') or rootfiles[0].get('fullPath')
    return normalize_path(full) if full else None


def parse_opf(opf_text: str, opf_path: str):
    base_dir = normalize_path(os.path.dirname(opf_path))
    try:
        doc = ET.fromstring(opf_text)
    except ET.ParseError:
        return {
            'manifest_paths': [],
            'spine_paths': [],
            'manifest_map': {},
        }
    # Detect default namespace
    ns_uri = doc.tag.split('}')[0].strip('{') if '}' in doc.tag else ''
    ns = {'opf': ns_uri} if ns_uri else {}

    def join_href(href: str) -> str:
        return normalize_path(os.path.join(base_dir, href))

    manifest_paths: list[str] = []
    manifest_map: dict[str, str] = {}
    id_to_href: dict[str, str] = {}

    for item in doc.findall('.//opf:manifest/opf:item', ns) or doc.findall('.//manifest/item'):
        href = item.get('href') or ''
        media_type = item.get('media-type') or ''
        id_attr = item.get('id') or ''
        if not href:
            continue
        full = join_href(href)
        manifest_paths.append(full)
        if media_type:
            manifest_map[full] = media_type
        if id_attr:
            id_to_href[id_attr] = full

    spine_paths: list[str] = []
    for it in doc.findall('.//opf:spine/opf:itemref', ns) or doc.findall('.//spine/itemref'):
        idref = it.get('idref') or ''
        full = id_to_href.get(idref)
        if full:
            spine_paths.append(full)

    return {
        'manifest_paths': manifest_paths,
        'spine_paths': spine_paths,
        'manifest_map': manifest_map,
    }


def compare_epub(orig_path: str, trans_path: str) -> str:
    report_lines: list[str] = []
    report_lines.append(f'ORIG: {orig_path}')
    report_lines.append(f'TRAN: {trans_path}')

    with zipfile.ZipFile(orig_path, 'r') as zo, zipfile.ZipFile(trans_path, 'r') as zt:
        names_o = zip_namelist_files(zo)
        names_t = zip_namelist_files(zt)

        set_o = set(names_o)
        set_t = set(names_t)

        report_lines.append('== FILE COUNTS ==')
        report_lines.append(f'orig files: {len(names_o)}')
        report_lines.append(f'tran files: {len(names_t)}')

        missing = sorted(set_o - set_t)
        extra = sorted(set_t - set_o)
        if missing:
            report_lines.append('Missing in translated:')
            report_lines.append(', '.join(missing[:50]) + (' ...' if len(missing) > 50 else ''))
        if extra:
            report_lines.append('Extra in translated:')
            report_lines.append(', '.join(extra[:50]) + (' ...' if len(extra) > 50 else ''))

        # mimetype checks
        for label, zf, names in [('orig', zo, names_o), ('tran', zt, names_t)]:
            if 'mimetype' not in names:
                report_lines.append(f'[{label}] missing mimetype file')
                continue
            info = zf.getinfo('mimetype')
            content = read_text_from_zip(zf, 'mimetype', encoding='ascii', errors='ignore').strip()
            is_first = (names[0] == 'mimetype') if names else False
            compress = info.compress_type
            report_lines.append(f'[{label}] mimetype content: {content!r}, first={is_first}, compress_type={compress}')
            if content != 'application/epub+zip':
                report_lines.append(f'[{label}] ERROR: mimetype content invalid')
            if not is_first:
                report_lines.append(f'[{label}] ERROR: mimetype is not first')
            if compress != zipfile.ZIP_STORED:
                report_lines.append(f'[{label}] ERROR: mimetype must be STORED (no compression)')

        # container.xml and OPF
        def extract_opf(zf: zipfile.ZipFile):
            if 'META-INF/container.xml' not in zf.namelist():
                return None, None, None
            ctext = read_text_from_zip(zf, 'META-INF/container.xml')
            opf_rel = get_rootfile_from_container(ctext)
            if not opf_rel or opf_rel not in zf.namelist():
                return ctext, opf_rel, None
            opf_text = read_text_from_zip(zf, opf_rel)
            parsed = parse_opf(opf_text, opf_rel)
            return ctext, opf_rel, parsed

        c_o, opf_o_rel, opf_o = extract_opf(zo)
        c_t, opf_t_rel, opf_t = extract_opf(zt)

        report_lines.append('== OPF PATHS ==')
        report_lines.append(f'orig OPF: {opf_o_rel}')
        report_lines.append(f'tran OPF: {opf_t_rel}')
        if opf_o_rel != opf_t_rel:
            report_lines.append('ERROR: OPF path differs between original and translated')

        if opf_o and opf_t:
            man_o = set(opf_o['manifest_paths'])
            man_t = set(opf_t['manifest_paths'])
            man_missing = sorted(man_o - man_t)
            man_extra = sorted(man_t - man_o)
            if man_missing:
                report_lines.append('Manifest missing in translated:')
                report_lines.append(', '.join(man_missing[:50]) + (' ...' if len(man_missing) > 50 else ''))
            if man_extra:
                report_lines.append('Manifest extra in translated:')
                report_lines.append(', '.join(man_extra[:50]) + (' ...' if len(man_extra) > 50 else ''))

            # media-type differences for common paths
            common = sorted(man_o & man_t)
            for p in common:
                mt_o = opf_o['manifest_map'].get(p, '')
                mt_t = opf_t['manifest_map'].get(p, '')
                if mt_o != mt_t:
                    report_lines.append(f'MEDIA-TYPE DIFF: {p}: {mt_o} vs {mt_t}')

            # spine comparison
            spine_o = opf_o['spine_paths']
            spine_t = opf_t['spine_paths']
            report_lines.append(f'SPINE length: {len(spine_o)} vs {len(spine_t)}')
            min_len = min(len(spine_o), len(spine_t))
            diff_idx = -1
            for i in range(min_len):
                if spine_o[i] != spine_t[i]:
                    diff_idx = i
                    break
            report_lines.append(f'FIRST SPINE DIFF INDEX: {diff_idx}')

            # existence checks for referenced files
            for p in man_o:
                if p not in set_o:
                    report_lines.append(f'ORIG manifest references missing file in zip: {p}')
            for p in man_t:
                if p not in set_t:
                    report_lines.append(f'TRAN manifest references missing file in zip: {p}')

            # try to parse xhtml for well-formedness
            xhtml_common = [p for p in common if opf_o['manifest_map'].get(p) == 'application/xhtml+xml']
            bad_xhtml = []
            for p in xhtml_common[:50]:  # sample up to 50
                try:
                    text_t = read_text_from_zip(zt, p)
                    ET.fromstring(text_t)
                except Exception:
                    bad_xhtml.append(p)
            if bad_xhtml:
                report_lines.append('Translated XHTML not well-formed (sample):')
                report_lines.append(', '.join(bad_xhtml[:20]) + (' ...' if len(bad_xhtml) > 20 else ''))

        # Content differences on common files
        report_lines.append('== COMMON FILE CONTENT DIFF (first 50) ==')
        common_all = sorted(set_o & set_t)
        changed = []
        non_html_changed = []
        changed_html_paths = []
        changed_blobs_t: dict[str, bytes] = {}
        for p in common_all:
            try:
                b_o = zo.read(p)
                b_t = zt.read(p)
            except KeyError:
                continue
            if b_o != b_t:
                # record size and sha1
                sha_o = hashlib.sha1(b_o).hexdigest()[:10]
                sha_t = hashlib.sha1(b_t).hexdigest()[:10]
                changed.append(f"{p}  ({len(b_o)} -> {len(b_t)} bytes)  {sha_o} -> {sha_t}")
                if not (p.lower().endswith('.html') or p.lower().endswith('.xhtml')) and p != 'mimetype':
                    non_html_changed.append(p)
                else:
                    changed_html_paths.append(p)
                    changed_blobs_t[p] = b_t
        if changed:
            report_lines.extend(changed[:50])
        else:
            report_lines.append('no content diffs')

        # Heuristic checks for translated HTML/XHTML issues
        def find_html_issues(path: str, text: str, is_xhtml: bool, zip_names: set[str]) -> list[str]:
            issues: list[str] = []
            lower = text.lower()
            # xmlns for xhtml
            if is_xhtml:
                if '<html' in lower and 'xmlns=' not in lower.split('>', 1)[0]:
                    issues.append('missing xmlns on <html>')
            # ampersand escapes
            bad_amp = re.findall(r'&(?!#\d+;|#x[0-9A-Fa-f]+;|[A-Za-z][A-Za-z0-9]+;)', text)
            if bad_amp:
                issues.append('unescaped & found')
            # self-closing img for xhtml
            if is_xhtml:
                if re.search(r'<img\b[^>]*(?<!/)>' , text, flags=re.IGNORECASE):
                    issues.append('xhtml <img> not self-closed')
                if re.search(r'<br\b[^>]*(?<!/)>' , text, flags=re.IGNORECASE):
                    issues.append('xhtml <br> not self-closed')
                if re.search(r'<hr\b[^>]*(?<!/)>' , text, flags=re.IGNORECASE):
                    issues.append('xhtml <hr> not self-closed')
            # resource existence
            base_dir = normalize_path(os.path.dirname(path))
            for m in re.finditer(r'(?:src|href)=["\']([^"\']+)["\']', text, flags=re.IGNORECASE):
                href = m.group(1).strip()
                if not href or href.startswith('#') or re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', href):
                    continue
                full = normalize_path(os.path.join(base_dir, href))
                if full not in zip_names:
                    issues.append(f'missing referenced resource: {full}')
            # toc checks
            if os.path.basename(path).lower().startswith('toc'):
                if 'nav' not in lower or ('epub:type="toc"' not in lower and 'role="doc-toc"' not in lower):
                    issues.append('toc.xhtml: missing <nav epub:type="toc"> or role="doc-toc"')
            return issues

        zip_names_set = set_t
        html_issues: list[str] = []
        for p in changed_html_paths[:20]:
            text_t = changed_blobs_t[p].decode('utf-8', errors='replace')
            # decide xhtml by extension or media-type
            is_xhtml = p.lower().endswith('.xhtml')
            html_issues.extend([f'{p}: {msg}' for msg in find_html_issues(p, text_t, is_xhtml, zip_names_set)])

        if html_issues:
            report_lines.append('== XHTML/HTML ISSUES (translated, sample) ==')
            report_lines.extend(html_issues[:50])

        # Summary section
        report_lines.append('== SUMMARY ==')
        if missing or extra:
            report_lines.append('Files set differs (missing/extra).')
        if opf_o_rel != opf_t_rel:
            report_lines.append('OPF rootfile path differs.')
        if opf_o and opf_t:
            if man_missing or man_extra:
                report_lines.append('OPF manifest differs.')
            mt_diffs = sum(1 for p in (set(opf_o['manifest_paths']) & set(opf_t['manifest_paths'])) if opf_o['manifest_map'].get(p,'') != opf_t['manifest_map'].get(p,''))
            if mt_diffs:
                report_lines.append(f'Media-type differs for {mt_diffs} file(s).')
            if diff_idx != -1 or len(opf_o['spine_paths']) != len(opf_t['spine_paths']):
                report_lines.append('OPF spine order/length differs.')
        if non_html_changed:
            report_lines.append(f'Non-HTML changed files (sample): {", ".join(non_html_changed[:10])}')
        if html_issues:
            report_lines.append('HTML/XHTML issues detected (see above).')
        if not (missing or extra) and (opf_o_rel == opf_t_rel) and (not opf_o or (not man_missing and not man_extra and diff_idx == -1 and len(opf_o['spine_paths']) == len(opf_t['spine_paths'])) and (mt_diffs if opf_o and opf_t else 0) == 0) and not non_html_changed:
            report_lines.append('Structures and non-HTML content identical. If Apple Books fails, likely malformed HTML/XHTML content.')

    return '\n'.join(report_lines)


def _auto_detect_from_temp():
    temp_dir = 'temp'
    if not os.path.isdir(temp_dir):
        return None, None
    files = [os.path.join(temp_dir, f) for f in os.listdir(temp_dir) if f.lower().endswith('.epub')]
    if not files:
        return None, None
    # Heuristic: translation contains '_ua'
    trans = None
    orig = None
    for f in files:
        name = os.path.basename(f)
        if '_ua' in name:
            trans = f
        else:
            orig = f if orig is None else orig
    return orig, trans


def main():
    if len(sys.argv) >= 3:
        orig, trans = sys.argv[1], sys.argv[2]
    else:
        orig, trans = _auto_detect_from_temp()
        if not orig or not trans:
            print('Usage: python compare_epub.py <original.epub> <translated.epub>')
            print('Or place files in ./temp as <name>.epub and <name>_ua*.epub and run without args.')
            sys.exit(2)
        print(f'Auto-detected files in temp:')
        print(f'  ORIG: {orig}')
        print(f'  TRAN: {trans}')
    report = compare_epub(orig, trans)
    # Also save to temp/compare_report.txt if temp exists
    out_path = os.path.join('temp', 'compare_report.txt')
    try:
        os.makedirs('temp', exist_ok=True)
        with io.open(out_path, 'w', encoding='utf-8') as f:
            f.write(report)
    except Exception:
        pass
    print(report)


if __name__ == '__main__':
    main()


