(() => {
    /** @typedef {{sourceId: string, kind: 'url'|'file', name: string}} Source */
    /** @typedef {{name: string, value: number, labels?: Record<string,string>, source?: string}} Metric */

    const state = {
        /** @type {Map<string, Source>} */
        sources: new Map(),
        /** @type {Map<string, Metric[]>} */
        metricsByName: new Map(),
        filterText: '',
        refreshTimer: /** @type {number|undefined} */ (undefined),
    };

    const dom = {
        urlInput: /** @type {HTMLInputElement} */ (document.getElementById('urlInput')),
        addSourceBtn: /** @type {HTMLButtonElement} */ (document.getElementById('addSourceBtn')),
        fileInput: /** @type {HTMLInputElement} */ (document.getElementById('fileInput')),
        refreshInterval: /** @type {HTMLInputElement} */ (document.getElementById('refreshInterval')),
        autoRefresh: /** @type {HTMLInputElement} */ (document.getElementById('autoRefresh')),
        refreshNowBtn: /** @type {HTMLButtonElement} */ (document.getElementById('refreshNowBtn')),
        filterInput: /** @type {HTMLInputElement} */ (document.getElementById('filterInput')),
        status: /** @type {HTMLElement} */ (document.getElementById('status')),
        sources: /** @type {HTMLElement} */ (document.getElementById('sources')),
        tableBody: /** @type {HTMLElement} */ (document.getElementById('tableBody')),
        tableHead: /** @type {HTMLElement} */ (document.getElementById('tableHead')),
    };

    const uid = () => Math.random().toString(36).slice(2, 10);

    function setStatus(text) {
        dom.status.textContent = text;
    }

    function addSource(kind, name) {
        const sourceId = uid();
        state.sources.set(sourceId, { sourceId, kind, name });
        drawSources();
        return sourceId;
    }

    function removeSource(sourceId) {
        state.sources.delete(sourceId);
        drawSources();
    }

    function drawSources() {
        dom.sources.innerHTML = '';
        for (const [sourceId, s] of state.sources.entries()) {
            const chip = document.createElement('span');
            chip.className = 'chip';
            chip.textContent = s.name;
            const x = document.createElement('button');
            x.textContent = '×';
            x.title = 'Remove';
            x.addEventListener('click', () => removeSource(sourceId));
            chip.appendChild(x);
            dom.sources.appendChild(chip);
        }
    }

    async function fetchTextFromSource(source) {
        if (source.kind === 'url') {
            const res = await fetch(source.name, { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const ct = res.headers.get('content-type') || '';
            if (ct.includes('application/json')) {
                const json = await res.json();
                return { type: 'json', text: JSON.stringify(json), json };
            }
            const text = await res.text();
            return { type: 'text', text };
        } else {
            // 'file' kind stores a pseudo-URL name like file:<id>, but we keep File in closure
            // Here, name is used only for labeling; actual content loaded on add
            // This path is not called; file content is provided directly by caller
            throw new Error('Unsupported direct file fetch');
        }
    }

    function parsePrometheusText(content) {
        /** @type {Metric[]} */
        const out = [];
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            // example: http_requests_total{method="post",code="200"} 1027
            const match = trimmed.match(/^(?<name>[a-zA-Z_:][a-zA-Z0-9_:]*)(?<labels>\{[^}]*\})?\s+(?<value>[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)\s*(?<ts>[0-9]+)?/);
            if (!match || !match.groups) continue;
            const name = match.groups.name;
            const value = Number(match.groups.value);
            /** @type {Record<string,string>|undefined} */
            let labels;
            if (match.groups.labels) {
                labels = {};
                const raw = match.groups.labels.slice(1, -1);
                for (const kv of raw.split(/,(?=(?:[^\\"]*\\"[^\\"]*\\")*[^\\"]*$)/)) {
                    const [k, v] = kv.split('=');
                    if (!k) continue;
                    const unq = (v || '').replace(/^\"|\"$/g, '').replace(/\\\"/g, '"');
                    labels[k.trim()] = unq;
                }
            }
            out.push({ name, value, labels });
        }
        return out;
    }

    function parseJson(content) {
        /** @type {Metric[]} */
        const out = [];
        if (Array.isArray(content)) {
            for (const item of content) {
                if (item && typeof item.name === 'string' && typeof item.value === 'number') {
                    out.push({ name: item.name, value: item.value, labels: item.labels || undefined });
                }
            }
        } else if (content && typeof content === 'object') {
            for (const [name, value] of Object.entries(content)) {
                if (typeof value === 'number') out.push({ name, value });
                else if (value && typeof value === 'object') {
                    const val = Number(value.value);
                    if (!Number.isNaN(val)) out.push({ name, value: val, labels: value.labels || undefined });
                }
            }
        }
        return out;
    }

    function aggregate(metrics) {
        const sum = metrics.reduce((acc, m) => acc + (Number.isFinite(m.value) ? m.value : 0), 0);
        return sum;
    }

    function formatNumber(n) {
        if (!Number.isFinite(n)) return 'NaN';
        if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
        if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
        if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + 'K';
        return String(Math.round(n * 100) / 100);
    }

    function renderTable() {
        const filter = state.filterText.toLowerCase();
        const rows = [];
        for (const [name, metrics] of state.metricsByName.entries()) {
            if (filter && !name.toLowerCase().includes(filter)) continue;
            const agg = aggregate(metrics);
            const details = metrics.map(m => {
                const labelStr = m.labels ? '{' + Object.entries(m.labels).map(([k, v]) => `${k}="${v}"`).join(',') + '}' : '';
                const src = m.source ? ` <span class="muted">@${m.source}</span>` : '';
                return `<div class="mono">${labelStr} = <b>${formatNumber(m.value)}</b>${src}</div>`;
            }).join('');
            rows.push(`<tr><td class="mono">${name}</td><td><b>${formatNumber(agg)}</b></td><td>${details}</td></tr>`);
        }
        dom.tableBody.innerHTML = rows.join('');
    }

    function clearMetrics() {
        state.metricsByName.clear();
    }

    function addMetricsToState(metrics, sourceLabel) {
        for (const m of metrics) {
            const arr = state.metricsByName.get(m.name) || [];
            arr.push({ ...m, source: sourceLabel });
            state.metricsByName.set(m.name, arr);
        }
    }

    async function refreshOnce() {
        if (state.sources.size === 0) {
            setStatus('No sources. Add a URL or load a file.');
            dom.tableBody.innerHTML = '';
            return;
        }
        setStatus('Loading...');
        clearMetrics();
        const tasks = [];
        for (const s of state.sources.values()) {
            if (s.kind === 'url') {
                tasks.push((async () => {
                    try {
                        const res = await fetchTextFromSource(s);
                        if (res.type === 'json') {
                            const parsed = parseJson(res.json);
                            addMetricsToState(parsed, s.name);
                        } else {
                            const parsed = parsePrometheusText(res.text);
                            addMetricsToState(parsed, s.name);
                        }
                    } catch (e) {
                        console.error('Fetch failed for', s.name, e);
                    }
                })());
            }
        }
        await Promise.all(tasks);
        renderTable();
        setStatus(`Updated ${new Date().toLocaleTimeString()} from ${state.sources.size} source(s)`);
    }

    function restartTimer() {
        if (state.refreshTimer) window.clearInterval(state.refreshTimer);
        if (!dom.autoRefresh.checked) return;
        const sec = Math.max(2, Number(dom.refreshInterval.value) || 10);
        state.refreshTimer = window.setInterval(refreshOnce, sec * 1000);
    }

    // Wire events
    dom.addSourceBtn.addEventListener('click', () => {
        const url = dom.urlInput.value.trim();
        if (!url) return;
        addSource('url', url);
        dom.urlInput.value = '';
        refreshOnce();
    });
    dom.urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') dom.addSourceBtn.click();
    });
    dom.fileInput.addEventListener('change', async (e) => {
        const files = dom.fileInput.files;
        if (!files || files.length === 0) return;
        clearMetrics();
        for (const file of files) {
            const text = await file.text();
            const isJson = file.name.toLowerCase().endsWith('.json');
            let metrics;
            if (isJson) {
                try { metrics = parseJson(JSON.parse(text)); } catch { metrics = []; }
            } else {
                metrics = parsePrometheusText(text);
            }
            addMetricsToState(metrics, file.name);
            addSource('file', file.name);
        }
        renderTable();
        setStatus(`Loaded ${files.length} file(s)`);
        dom.fileInput.value = '';
    });
    dom.refreshNowBtn.addEventListener('click', () => refreshOnce());
    dom.refreshInterval.addEventListener('change', () => restartTimer());
    dom.autoRefresh.addEventListener('change', () => restartTimer());
    dom.filterInput.addEventListener('input', () => { state.filterText = dom.filterInput.value; renderTable(); });

    document.getElementById('loadSampleTxt').addEventListener('click', async () => {
        const url = 'metrics-sample.txt';
        if (![...state.sources.values()].some(s => s.name === url)) addSource('url', url);
        await refreshOnce();
    });
    document.getElementById('loadSampleJson').addEventListener('click', async () => {
        const url = 'metrics-sample.json';
        if (![...state.sources.values()].some(s => s.name === url)) addSource('url', url);
        await refreshOnce();
    });

    // Initial
    restartTimer();
})();


