import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Upload, FileText, Download, Languages, AlertCircle, CheckCircle, Settings } from 'lucide-react';

const EPUBTranslator = () => {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [translatedContent, setTranslatedContent] = useState(null);
  const [error, setError] = useState('');
  const [comparison, setComparison] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gpt-4o-mini');
  const [showSettings, setShowSettings] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const savedKey = localStorage.getItem('openai_api_key') || '';
    const savedModel = localStorage.getItem('openai_model') || 'gpt-4o-mini';
    setApiKey(savedKey);
    setModel(savedModel);
  }, []);

  useEffect(() => {
    try { localStorage.setItem('openai_api_key', apiKey || ''); } catch {}
  }, [apiKey]);

  useEffect(() => {
    try { localStorage.setItem('openai_model', model || 'gpt-4o-mini'); } catch {}
  }, [model]);

  // Функция для загрузки JSZip из CDN
  const loadJSZip = (): Promise<any> => {
    return new Promise((resolve, reject) => {
      const w: any = window as any;
      if (w.JSZip) {
        resolve(w.JSZip);
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      script.onload = () => resolve((window as any).JSZip);
      script.onerror = () => reject(new Error('Не удалось загрузить JSZip'));
      document.head.appendChild(script);
    });
  };

  // Сбор текстовых узлов из DOM (исключая script/style)
  const collectTextNodes = (root: Document | HTMLElement): Text[] => {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (!node || !node.parentElement) return NodeFilter.FILTER_REJECT;
        const tag = node.parentElement.tagName?.toLowerCase();
        if (tag === 'script' || tag === 'style') return NodeFilter.FILTER_REJECT;
        const text = (node as Text).nodeValue ?? '';
        return text.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n as Text);
    return nodes;
  };

  // Вспомогательные утилиты путей внутри EPUB
  const normalizePath = (p: string): string => {
    const parts = p.replace(/\\/g, '/').split('/');
    const stack: string[] = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') { stack.pop(); continue; }
      stack.push(part);
    }
    return stack.join('/');
  };
  const dirname = (p: string): string => {
    const norm = normalizePath(p);
    const idx = norm.lastIndexOf('/');
    return idx === -1 ? '' : norm.slice(0, idx);
  };
  const joinPath = (baseDir: string, rel: string): string => {
    return normalizePath((baseDir ? baseDir + '/' : '') + rel);
  };

  // Чтение пути к OPF из META-INF/container.xml
  const getOpfPathFromContainer = async (zip: any): Promise<string | null> => {
    const containerPath = 'META-INF/container.xml';
    if (!zip.files[containerPath]) return null;
    const xml = await zip.files[containerPath].async('string');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const rootfile = doc.querySelector('rootfile');
    const fullPath = rootfile?.getAttribute('full-path') || rootfile?.getAttribute('fullPath');
    return fullPath ? normalizePath(fullPath) : null;
  };

  // Построение карт media-type для href из OPF
  const buildMediaTypeMaps = async (zip: any): Promise<{ xhtml: Set<string>; html: Set<string> } | null> => {
    const opfPath = await getOpfPathFromContainer(zip);
    if (!opfPath) return null;
    if (!zip.files[opfPath]) return null;
    const xml = await zip.files[opfPath].async('string');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const baseDir = dirname(opfPath);
    const xhtml = new Set<string>();
    const html = new Set<string>();
    doc.querySelectorAll('manifest > item').forEach((item) => {
      const href = item.getAttribute('href') || '';
      const mediaType = item.getAttribute('media-type') || '';
      if (!href) return;
      const full = joinPath(baseDir, href);
      if (mediaType === 'application/xhtml+xml') xhtml.add(full);
      if (mediaType === 'text/html') html.add(full);
    });
    return { xhtml, html };
  };

  // Перевод HTML/XHTML с сохранением структуры DOM
  const translateHtmlPreserveStructure = async (
    html: string,
    filePath: string,
    controller?: AbortController,
    forceXhtml?: boolean
  ) => {
    const isXhtml = forceXhtml !== undefined ? forceXhtml : /\.xhtml$/i.test(filePath || '');
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, isXhtml ? 'application/xhtml+xml' : 'text/html');

    const textNodes: Text[] = collectTextNodes(doc);
    if (textNodes.length === 0) return html;

    // Группируем сегменты в батчи по символам
    const allTexts: string[] = textNodes.map(n => n.nodeValue || '');
    const batches: string[][] = [];
    const maxChars = 6000; // приблизительный лимит
    let current: string[] = [];
    let len = 0;
    for (const t of allTexts) {
      const tLen = (t || '').length;
      if (len + tLen > maxChars && current.length > 0) {
        batches.push(current);
        current = [];
        len = 0;
      }
      current.push(t);
      len += tLen;
    }
    if (current.length > 0) batches.push(current);

    let translatedAll: string[] = [];
    for (const batch of batches) {
      const partial = await translateSegmentsWithOpenAI(batch, controller);
      translatedAll = translatedAll.concat(partial);
    }

    // Записываем переводы обратно
    for (let i = 0; i < textNodes.length; i++) {
      textNodes[i].nodeValue = translatedAll[i];
    }

    // Гарантируем xmlns и meta charset
    if (isXhtml) {
      const root = doc.documentElement;
      if (root && !root.getAttribute('xmlns')) {
        root.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      }
    }
    let head = doc.querySelector('head');
    if (!head) {
      head = doc.createElement('head');
      const htmlEl = doc.documentElement;
      if (htmlEl.firstChild) htmlEl.insertBefore(head, htmlEl.firstChild); else htmlEl.appendChild(head);
    }
    if (isXhtml) {
      // Для XHTML предпочитаем http-equiv
      if (!head.querySelector('meta[http-equiv="Content-Type"]')) {
        const meta = doc.createElement('meta');
        meta.setAttribute('http-equiv', 'Content-Type');
        meta.setAttribute('content', 'application/xhtml+xml; charset=utf-8');
        head.insertBefore(meta, head.firstChild);
      }
    } else {
      if (!head.querySelector('meta[charset]')) {
        const meta = doc.createElement('meta');
        meta.setAttribute('charset', 'utf-8');
        head.insertBefore(meta, head.firstChild);
      }
    }

    const serializer = new XMLSerializer();
    let serialized = serializer.serializeToString(doc);
    // Добавляем пролог/doctype при необходимости
    if (isXhtml) {
      if (!/^\s*<\?xml/i.test(html)) {
        serialized = `<?xml version="1.0" encoding="UTF-8"?>\n${serialized}`;
      }
    } else {
      if (!/^\s*<!DOCTYPE\s+html>/i.test(html)) {
        serialized = `<!DOCTYPE html>\n${serialized}`;
      }
    }
    return serialized;
  };

  // Перевод массива сегментов через OpenAI, возвращает массив переводов в том же порядке
  const translateSegmentsWithOpenAI = async (segments: string[], controller?: AbortController) => {
    const url = 'https://api.openai.com/v1/chat/completions';
    const body = {
      model: model || 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'You are a professional book translator. Translate Russian to Ukrainian. Return only strict JSON with key "translations" as an array of strings. Keep markup placeholders unchanged.'
        },
        {
          role: 'user',
          content: JSON.stringify({ task: 'translate_list', source_language: 'ru', target_language: 'uk', segments })
        }
      ]
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller?.signal
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`OpenAI API ошибка: ${response.status} ${response.statusText} ${text}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Пустой ответ OpenAI');
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      // Попытка удалить возможные обёртки кодовых блоков
      const cleaned = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      parsed = JSON.parse(cleaned);
    }
    if (!parsed || !Array.isArray(parsed.translations)) {
      throw new Error('Некорректный формат ответа OpenAI (ожидался { translations: string[] })');
    }
    if (parsed.translations.length !== segments.length) {
      throw new Error('Размер перевода не совпадает с количеством сегментов');
    }
    return parsed.translations;
  };

  // Анализ структуры EPUB файла
  interface EpubAnalysis {
    label: string;
    totalSize: number;
    fileCount: number;
    fileOrder: string[];
    structure: {
      mimetype?: { content: string; isFirst: boolean };
      container?: { present: boolean; content: string; rootfilePath?: string };
      htmlFiles?: number;
      opf?: {
        path: string | null;
        manifestPaths: string[];
        spinePaths: string[];
        manifestMap: Record<string, string>; // path -> media-type
      };
    };
    issues: string[];
  }

  const analyzeEPUB = async (epubBlob: Blob, label: string): Promise<EpubAnalysis> => {
    const JSZip: any = await loadJSZip();
    const zip = new JSZip();
    const arrayBuffer = await epubBlob.arrayBuffer();
    const epub = await zip.loadAsync(arrayBuffer);
    
    const analysis: EpubAnalysis = {
      label,
      totalSize: epubBlob.size,
      fileCount: Object.keys(epub.files).length,
      fileOrder: [] as string[],
      structure: {} as EpubAnalysis['structure'],
      issues: [] as string[]
    };

    // Анализируем список файлов
    Object.keys(epub.files).forEach(path => {
      if (!epub.files[path].dir) {
        analysis.fileOrder.push(path);
      }
    });

    // Проверяем mimetype
    if (epub.files['mimetype']) {
      const mimeContent = await epub.files['mimetype'].async('string');
      analysis.structure.mimetype = {
        content: mimeContent.trim(),
        isFirst: analysis.fileOrder[0] === 'mimetype'
      };
      
      if (analysis.structure.mimetype.content !== 'application/epub+zip') {
        analysis.issues.push('Неправильный mimetype');
      }
      if (!analysis.structure.mimetype.isFirst) {
        analysis.issues.push('mimetype не первый файл');
      }
    } else {
      analysis.issues.push('Отсутствует mimetype');
    }

    // Проверяем container.xml и извлекаем OPF
    if (epub.files['META-INF/container.xml']) {
      const containerContent = await epub.files['META-INF/container.xml'].async('string');
      let rootfilePath: string | undefined;
      try {
        const doc = new DOMParser().parseFromString(containerContent, 'application/xml');
        const rootfile = doc.querySelector('rootfile');
        rootfilePath = rootfile?.getAttribute('full-path') || rootfile?.getAttribute('fullPath') || undefined;
      } catch {}
      analysis.structure.container = {
        present: true,
        content: containerContent.substring(0, 200) + '...',
        rootfilePath
      };

      // Читаем OPF
      const opfPath = rootfilePath || null;
      let manifestPaths: string[] = [];
      let spinePaths: string[] = [];
      const manifestMap: Record<string, string> = {};
      if (opfPath && epub.files[opfPath]) {
        try {
          const opfXml = await epub.files[opfPath].async('string');
          const doc = new DOMParser().parseFromString(opfXml, 'application/xml');
          const baseDir = dirname(opfPath);
          const idToHref: Record<string, string> = {};
          doc.querySelectorAll('manifest > item').forEach((item) => {
            const id = item.getAttribute('id') || '';
            const href = item.getAttribute('href') || '';
            const mediaType = item.getAttribute('media-type') || '';
            if (!href) return;
            const full = joinPath(baseDir, href);
            manifestPaths.push(full);
            if (mediaType) manifestMap[full] = mediaType;
            if (id) idToHref[id] = full;
          });
          doc.querySelectorAll('spine > itemref').forEach((ir) => {
            const idref = ir.getAttribute('idref') || '';
            const full = idToHref[idref];
            if (full) spinePaths.push(full);
          });
        } catch {}
      }
      analysis.structure.opf = {
        path: opfPath,
        manifestPaths,
        spinePaths,
        manifestMap
      };
    } else {
      analysis.issues.push('Отсутствует container.xml');
    }

    // HTML файлы (по расширению, информационно)
    const htmlFiles = analysis.fileOrder.filter((f: string) => f.match(/\.(html|xhtml)$/i));
    analysis.structure.htmlFiles = htmlFiles.length;

    return analysis;
  };

  // Сравнение двух EPUB файлов
  const compareEPUBs = async (original: Blob, translated: Blob) => {
    try {
      setStatus('analyzing');
      
      const originalAnalysis = await analyzeEPUB(original, 'Исходный');
      const translatedAnalysis = await analyzeEPUB(translated, 'Переведенный');
      
      const comp: any = {
        original: originalAnalysis,
        translated: translatedAnalysis,
        differences: [] as string[]
      };

      // Сравнение количества файлов
      if (originalAnalysis.fileCount !== translatedAnalysis.fileCount) {
        comp.differences.push(`Разное количество файлов (включая папки): ${originalAnalysis.fileCount} vs ${translatedAnalysis.fileCount}`);
      }
      if (originalAnalysis.fileOrder.length !== translatedAnalysis.fileOrder.length) {
        comp.differences.push(`Разное количество файлов (без папок): ${originalAnalysis.fileOrder.length} vs ${translatedAnalysis.fileOrder.length}`);
      }

      // Сравнение наборов путей
      const oSet = new Set(originalAnalysis.fileOrder);
      const tSet = new Set(translatedAnalysis.fileOrder);
      const missingInTranslated: string[] = [];
      const extraInTranslated: string[] = [];
      for (const p of oSet) if (!tSet.has(p)) missingInTranslated.push(p);
      for (const p of tSet) if (!oSet.has(p)) extraInTranslated.push(p);
      if (missingInTranslated.length > 0) comp.differences.push(`Отсутствуют в переведённом: ${missingInTranslated.slice(0, 10).join(', ')}${missingInTranslated.length > 10 ? ' и др.' : ''}`);
      if (extraInTranslated.length > 0) comp.differences.push(`Лишние в переведённом: ${extraInTranslated.slice(0, 10).join(', ')}${extraInTranslated.length > 10 ? ' и др.' : ''}`);

      // Сравнение mimetype
      const origMime = originalAnalysis.structure.mimetype;
      const transMime = translatedAnalysis.structure.mimetype;
      if (origMime && transMime) {
        if (origMime.content !== transMime.content) comp.differences.push('Разное содержимое mimetype');
        if (origMime.isFirst !== transMime.isFirst) comp.differences.push('Разная позиция mimetype');
      }

      // Сравнение container.xml rootfile path
      const oRoot = originalAnalysis.structure.container?.rootfilePath || null;
      const tRoot = translatedAnalysis.structure.container?.rootfilePath || null;
      if (oRoot !== tRoot) comp.differences.push(`Разный путь OPF в container.xml: ${oRoot || '—'} vs ${tRoot || '—'}`);

      // Сравнение OPF
      const oOpf = originalAnalysis.structure.opf;
      const tOpf = translatedAnalysis.structure.opf;
      if (oOpf?.path !== tOpf?.path) comp.differences.push(`Разный путь к OPF: ${oOpf?.path || '—'} vs ${tOpf?.path || '—'}`);

      if (oOpf && tOpf) {
        // manifest
        const oMan = new Set(oOpf.manifestPaths);
        const tMan = new Set(tOpf.manifestPaths);
        const manMissing: string[] = [];
        const manExtra: string[] = [];
        for (const p of oMan) if (!tMan.has(p)) manMissing.push(p);
        for (const p of tMan) if (!oMan.has(p)) manExtra.push(p);
        if (manMissing.length > 0) comp.differences.push(`Manifest: отсутствуют в переведённом: ${manMissing.slice(0, 10).join(', ')}${manMissing.length > 10 ? ' и др.' : ''}`);
        if (manExtra.length > 0) comp.differences.push(`Manifest: лишние в переведённом: ${manExtra.slice(0, 10).join(', ')}${manExtra.length > 10 ? ' и др.' : ''}`);

        // media-type различия
        const common = [...oMan].filter(p => tMan.has(p));
        for (const p of common) {
          const mtO = oOpf.manifestMap[p] || '';
          const mtT = tOpf.manifestMap[p] || '';
          if (mtO !== mtT) comp.differences.push(`Media-type отличается для ${p}: ${mtO || '—'} vs ${mtT || '—'}`);
        }

        // spine (логический порядок чтения)
        const minLen = Math.min(oOpf.spinePaths.length, tOpf.spinePaths.length);
        for (let i = 0; i < minLen; i++) {
          if (oOpf.spinePaths[i] !== tOpf.spinePaths[i]) {
            comp.differences.push(`Spine отличается на позиции ${i}: ${oOpf.spinePaths[i] || '—'} vs ${tOpf.spinePaths[i] || '—'}`);
            break;
          }
        }
        if (oOpf.spinePaths.length !== tOpf.spinePaths.length) {
          comp.differences.push(`Длина spine различается: ${oOpf.spinePaths.length} vs ${tOpf.spinePaths.length}`);
        }
      }

      setComparison(comp);
      setStatus('idle');
      
    } catch (err) {
      setError(`Ошибка сравнения: ${err.message}`);
      setStatus('error');
    }
  };

  // Исправленная обработка EPUB с точным копированием структуры
  const processEPUBFixed = async (epubFile: File) => {
    try {
      setStatus('analyzing');
      setError('');

      const JSZip: any = await loadJSZip();
      const zip = new JSZip();
      const arrayBuffer = await epubFile.arrayBuffer();
      const originalEpub = await zip.loadAsync(arrayBuffer);
      
      // Определяем HTML/XHTML по OPF (если доступен), иначе по расширению
      const mediaMaps = await buildMediaTypeMaps(originalEpub).catch(() => null);
      const filePaths = Object.keys(originalEpub.files).filter(p => !originalEpub.files[p].dir);
      const xhtmlSet: Set<string> = mediaMaps?.xhtml || new Set<string>();
      const htmlSet: Set<string> = mediaMaps?.html || new Set<string>();
      const declaredHtml = new Set<string>([...xhtmlSet, ...htmlSet]);
      const htmlFiles = declaredHtml.size > 0
        ? filePaths.filter(p => declaredHtml.has(p))
        : filePaths.filter(p => /\.(html|xhtml)$/i.test(p));
      
      if (htmlFiles.length === 0) {
        throw new Error('HTML файлы не найдены');
      }

      setStatus('translating');
      const controller = new AbortController();
      abortRef.current = controller;
      
      // Создаем новый ZIP с ТОЧНО такой же структурой
      const newZip = new JSZip();
      
      // Сначала mimetype (обязательно первый и без сжатия)
      newZip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
      
      // Получаем оригинальный порядок файлов
      const originalOrder = Object.keys(originalEpub.files).filter(path => !originalEpub.files[path].dir && path !== 'mimetype');
      
      let processedChunks = 0;
      const totalChunks = htmlFiles.length;
      
      // Обрабатываем файлы в том же порядке
      for (const filePath of originalOrder) {
        const file = originalEpub.files[filePath];
        
        if (htmlFiles.includes(filePath)) {
          // Переводим HTML c сохранением структуры DOM через OpenAI
          const content = await file.async('string');
          if (!apiKey) throw new Error('Не задан OpenAI API ключ. Укажите его в настройках.');
          const treatAsXhtml = mediaMaps ? xhtmlSet.has(filePath) : /\.xhtml$/i.test(filePath);
          const translated = await translateHtmlPreserveStructure(content, filePath, controller, treatAsXhtml);
          newZip.file(filePath, translated, { compression: 'DEFLATE' });
          processedChunks++;
          setProgress(Math.round((processedChunks / totalChunks) * 100));
          
        } else {
          // Копируем остальные файлы точь-в-точь
          const content = await file.async('arraybuffer');
          newZip.file(filePath, content, { compression: 'DEFLATE' });
        }
      }
      
      // Генерируем с настройками как можно ближе к оригиналу
      const result = await newZip.generateAsync({
        type: 'blob',
        mimeType: 'application/epub+zip',
        compression: 'DEFLATE',
        compressionOptions: {
          level: 6
        }
      });
      
      setTranslatedContent(result);
      setStatus('completed');
      
    } catch (err) {
      if (err?.name === 'AbortError') {
        setError('Операция отменена');
        setStatus('idle');
      } else {
        setError(err.message || String(err));
        setStatus('error');
      }
    }
  };

  const handleFileSelect = (event) => {
    const selectedFile = event.target.files[0];
    if (selectedFile) {
      setFile(selectedFile);
      setComparison(null);
    }
  };

  const handleDrop = useCallback((event) => {
    event.preventDefault();
    const droppedFile = event.dataTransfer.files[0];
    if (droppedFile) {
      setFile(droppedFile);
      setComparison(null);
    }
  }, []);

  const downloadFile = () => {
    if (!translatedContent) return;
    
    const url = URL.createObjectURL(translatedContent);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name.replace(/\.epub$/i, '_ua.epub');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const reset = () => {
    try { abortRef.current?.abort(); } catch {}
    setFile(null);
    setStatus('idle');
    setProgress(0);
    setTranslatedContent(null);
    setError('');
    setComparison(null);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-8">
          <div className="flex justify-center items-center gap-3 mb-4">
            <Languages className="text-4xl text-indigo-600" size={48} />
            <h1 className="text-4xl font-bold text-gray-800">EPUB Translator</h1>
          </div>
          
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-8">
          {status === 'idle' && (
            <div className="space-y-6">
              <div className="bg-gray-50 p-6 rounded-xl">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Settings className="text-gray-600" size={20} />
                    <h4 className="font-semibold text-gray-800">Settings</h4>
                  </div>
                  <button
                    onClick={() => setShowSettings(v => !v)}
                    className="text-indigo-600 hover:text-indigo-700 text-sm font-semibold"
                  >
                    {showSettings ? 'Hide' : 'Show'}
                  </button>
                </div>
                {showSettings && (
                  <div className="grid md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm text-gray-700 mb-1">OpenAI API Key</label>
                      <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder="sk-..."
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      <p className="text-xs text-gray-500 mt-1">Key is stored locally in your browser (localStorage)</p>
                    </div>
                    <div>
                      <label className="block text-sm text-gray-700 mb-1">Model</label>
                      <select
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                      >
                        <option value="gpt-4o-mini">gpt-4o-mini</option>
                        <option value="gpt-4o">gpt-4o</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>
              <div
                className="border-2 border-dashed border-indigo-300 rounded-xl p-12 text-center hover:border-indigo-400 transition-colors cursor-pointer"
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                onClick={() => { const el = document.getElementById('epub-input') as HTMLInputElement | null; el?.click(); }}
              >
                <Upload className="mx-auto mb-4 text-indigo-500" size={64} />
                <h3 className="text-xl font-semibold text-gray-700 mb-2">
                  Choose an EPUB file
                </h3>
                <input
                  id="epub-input"
                  type="file"
                  accept=".epub"
                  onChange={handleFileSelect}
                  className="hidden"
                />
              </div>

              {file && (
                <div className="bg-indigo-50 p-6 rounded-xl">
                  <div className="flex items-center gap-3 mb-4">
                    <FileText className="text-indigo-600" size={24} />
                    <div>
                      <h4 className="font-semibold text-gray-800">{file.name}</h4>
                      <p className="text-gray-600 text-sm">
                        {(file.size / 1024 / 1024).toFixed(2)} MB
                      </p>
                    </div>
                  </div>
                  
                  <div className="flex gap-4">
                    <button
                      onClick={() => processEPUBFixed(file)}
                      disabled={!apiKey}
                      className={`px-6 py-3 rounded-lg transition-colors font-semibold ${apiKey ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-gray-300 text-gray-500 cursor-not-allowed'}`}
                    >
                      Translate (fixed)
                    </button>
                    {!apiKey && (
                      <span className="text-sm text-red-600 self-center">Provide OpenAI API key in Settings</span>
                    )}
                    <button 
                      onClick={reset} 
                      className="bg-gray-300 text-gray-700 px-6 py-3 rounded-lg hover:bg-gray-400 transition-colors"
                    >
                      Reset
                    </button>
                  </div>
                </div>
              )}

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
                  <AlertCircle className="text-red-500" size={24} />
                  <p className="text-red-700">{error}</p>
                </div>
              )}
            </div>
          )}

          {(status === 'analyzing' || status === 'translating') && (
            <div className="text-center space-y-6">
              <div className="flex justify-center">
                <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-indigo-600"></div>
              </div>
              
              <div className="space-y-4">
                <h3 className="text-xl font-semibold text-gray-800">
                  {status === 'analyzing' ? 'Analyzing…' : 'Translating…'}
                </h3>
                
                {status === 'translating' && (
                  <>
                    <div className="w-full bg-gray-200 rounded-full h-4">
                      <div
                        className="bg-indigo-600 h-4 rounded-full transition-all duration-300"
                        style={{ width: `${progress}%` }}
                      ></div>
                    </div>
                    <p className="text-gray-600">{progress}%</p>
                  </>
                )}
              </div>
              
              <button 
                onClick={reset} 
                className="bg-gray-300 text-gray-700 px-6 py-3 rounded-lg hover:bg-gray-400 transition-colors"
              >
                Cancel
              </button>
            </div>
          )}

          {status === 'completed' && (
            <div className="text-center space-y-6">
              <CheckCircle className="mx-auto text-green-500" size={64} />
              
              <div className="space-y-4">
                <h3 className="text-2xl font-semibold text-gray-800">Translation completed!</h3>
                <p className="text-gray-600">File created with fixed structure</p>
              </div>
              
              <div className="flex gap-4 justify-center">
                <button
                  onClick={downloadFile}
                  className="bg-green-600 text-white px-8 py-4 rounded-lg hover:bg-green-700 transition-colors font-semibold flex items-center gap-2"
                >
                  <Download size={20} />
                  Download book
                </button>
                <button 
                  onClick={reset} 
                  className="bg-gray-300 text-gray-700 px-6 py-4 rounded-lg hover:bg-gray-400 transition-colors"
                >
                  New book
                </button>
              </div>
            </div>
          )}

          {/* comparison UI removed */}

          {status === 'error' && (
            <div className="text-center space-y-6">
              <AlertCircle className="mx-auto text-red-500" size={64} />
              
              <div className="space-y-4">
                <h3 className="text-2xl font-semibold text-gray-800">An error occurred</h3>
                <div className="bg-red-50 border border-red-200 rounded-xl p-6">
                  <p className="text-red-700">{error}</p>
                </div>
              </div>
              
              <button 
                onClick={reset} 
                className="bg-indigo-600 text-white px-6 py-4 rounded-lg hover:bg-indigo-700 transition-colors"
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default EPUBTranslator;