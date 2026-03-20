import { invoke } from '@tauri-apps/api/core';

// ==================== 全局状态 ====================
let currentRequest = {
    id: null,
    name: '',
    method: 'GET',
    url: '',
    queryParams: [],
    headers: [],
    body: '',
    bodyType: 'none',
    rawFormat: 'json',
    bodyFields: [],
    binaryBody: '',
    graphqlQuery: '',
    graphqlVariables: '{}',
    isCustomName: false,
    sourceType: '',
    sourceId: ''
};

let collections = [];
let history = [];
let currentHistoryId = null;
let isUpdatingUrl = false;
let isUpdatingParams = false;
let latestResponseData = null;
let currentResponseView = 'body';
let currentBodyFormat = 'json';
let isBodyPreview = false;
let isBodyVisualize = false;
let isBodySearchVisible = false;
let bodySearchQuery = '';
let bodySearchIndex = 0;
let requestTabs = [];
let activeRequestTabId = null;
let requestTabsSearchQuery = '';
let isRequestTabsDropdownVisible = false;

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', async () => {
    await loadHistory();
    await loadCollections();
    initResizers();
    initUrlSync();
    attachRequestMetaListeners();
    initRequestTabs();
    switchRequestBodyType('none');
    updateBadges();

    const importModal = document.getElementById('importModal');
    importModal.addEventListener('click', (e) => {
        if (e.target === importModal) {
            closeImportModal();
        }
    });

    const saveModal = document.getElementById('saveRequestModal');
    saveModal.addEventListener('click', (e) => {
        if (e.target === saveModal) {
            closeSaveRequestModal();
        }
    });

    const bodySearchInput = document.getElementById('bodySearchInput');
    bodySearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            if (e.shiftKey) {
                gotoBodySearchPrev();
            } else {
                gotoBodySearchNext();
            }
        }
    });

    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f') {
            if (currentResponseView === 'body') {
                e.preventDefault();
                showBodySearch();
            }
            return;
        }

        if (e.key === 'Escape') {
            if (isRequestTabsDropdownVisible) {
                hideRequestTabsDropdown(true);
                return;
            }
            if (isBodySearchVisible) {
                hideBodySearch(true);
            }
        }
    });

    ['bodyEditor', 'bodyBinaryEditor', 'graphqlQueryEditor', 'graphqlVariablesEditor'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', () => {
                syncCurrentRequestFromUI();
            });
        }
    });

    const requestTabsTrack = document.getElementById('requestTabsTrack');
    if (requestTabsTrack) {
        requestTabsTrack.addEventListener('scroll', () => {
            updateRequestTabsOverflowControls();
        });
    }

    const requestTabsSearchInput = document.getElementById('requestTabsSearchInput');
    if (requestTabsSearchInput) {
        requestTabsSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                hideRequestTabsDropdown(true);
                e.preventDefault();
                return;
            }

            if (e.key === 'Enter') {
                const first = document.querySelector('.request-tabs-dropdown-item');
                if (first) {
                    const tabId = first.dataset.tabId;
                    if (tabId) {
                        activateTabById(tabId);
                        hideRequestTabsDropdown(false);
                    }
                }
                e.preventDefault();
            }
        });
    }

    document.addEventListener('click', (e) => {
        if (!isRequestTabsDropdownVisible) return;
        const bar = document.getElementById('requestTabsBar');
        if (bar && !bar.contains(e.target)) {
            hideRequestTabsDropdown(true);
        }
    });

    window.addEventListener('resize', () => {
        updateRequestTabsOverflowControls();
    });

    switchResponseView('body');
    switchBodyFormat('json');
});

function getEventTarget(evt) {
    return evt?.currentTarget || evt?.target || window.event?.currentTarget || window.event?.target || null;
}

function normalizeRequest(raw = {}) {
    const resolvedUrl = raw.url || '';
    const rawName = raw.name || '';
    const resolvedName = rawName || resolvedUrl || '';
    const resolvedIsCustomName = typeof raw.isCustomName === 'boolean'
        ? raw.isCustomName
        : (!!rawName && rawName !== resolvedUrl);

    return {
        id: raw.id || Date.now().toString(),
        name: resolvedName,
        method: raw.method || 'GET',
        url: resolvedUrl,
        queryParams: Array.isArray(raw.queryParams) ? raw.queryParams : [],
        headers: Array.isArray(raw.headers) ? raw.headers : [],
        body: raw.body || '',
        bodyType: raw.bodyType || 'none',
        rawFormat: raw.rawFormat || 'json',
        bodyFields: Array.isArray(raw.bodyFields) ? raw.bodyFields : [],
        binaryBody: raw.binaryBody || '',
        graphqlQuery: raw.graphqlQuery || '',
        graphqlVariables: raw.graphqlVariables || '{}',
        isCustomName: resolvedIsCustomName,
        sourceType: raw.sourceType || '',
        sourceId: raw.sourceId != null ? String(raw.sourceId) : ''
    };
}

function getRequestDisplayName(request) {
    const name = request?.name?.trim();
    const url = request?.url?.trim();
    return name || url || 'Untitled Request';
}

function isRequestTabReady(request = {}) {
    const method = (request.method || '').trim();
    const url = (request.url || '').trim();
    return !!method && !!url;
}

function buildRequestSignature(request = {}) {
    const method = (request.method || 'GET').toUpperCase().trim();
    const url = (request.url || '').trim();
    const name = (request.name || '').trim();
    return `${method}|${url}|${name}`;
}

function findTabBySource(sourceType, sourceId) {
    const sourceIdStr = String(sourceId);
    return requestTabs.find((tab) => tab.sourceType === sourceType && String(tab.sourceId) === sourceIdStr) || null;
}

function findExistingTabForRequest(sourceType, sourceId, requestPayload = {}) {
    const bySource = findTabBySource(sourceType, sourceId);
    if (bySource) return bySource;

    const requestId = requestPayload?.id ? String(requestPayload.id) : '';
    if (requestId) {
        const byId = requestTabs.find((tab) => String(tab.id) === requestId);
        if (byId) return byId;
    }

    const signature = buildRequestSignature(requestPayload);
    if (!signature) return null;
    return requestTabs.find((tab) => buildRequestSignature(tab) === signature) || null;
}

function activateTabById(tabId) {
    if (activeRequestTabId !== tabId) {
        switchRequestTab(tabId);
        return;
    }

    const active = getActiveTab();
    if (!active) return;
    currentRequest = active;
    renderRequestTabs();
    applyCurrentRequestToUI();
}

function openRequestFromSource(sourceType, sourceId, requestPayload) {
    const normalizedSourceId = String(sourceId);
    const existing = findExistingTabForRequest(sourceType, normalizedSourceId, requestPayload);
    if (existing) {
        existing.sourceType = sourceType;
        existing.sourceId = normalizedSourceId;
        activateTabById(existing.id);
        return { reused: true, tab: existing };
    }

    syncCurrentRequestFromUI();
    const newTab = createNewTabState();
    Object.assign(newTab, normalizeRequest({
        ...requestPayload,
        id: newTab.id,
        sourceType,
        sourceId: normalizedSourceId
    }));

    requestTabs.push(newTab);
    activeRequestTabId = newTab.id;
    currentRequest = newTab;
    renderRequestTabs();
    applyCurrentRequestToUI();
    return { reused: false, tab: newTab };
}

function createNewTabState() {
    return normalizeRequest({
        id: Date.now().toString(),
        method: document.getElementById('methodSelect')?.value || 'GET'
    });
}

function initRequestTabs() {
    if (requestTabs.length > 0) return;
    const initial = createNewTabState();
    requestTabs = [initial];
    activeRequestTabId = initial.id;
    currentRequest = initial;
    renderRequestTabs();
    applyCurrentRequestToUI();
}

function getActiveTab() {
    return requestTabs.find(tab => tab.id === activeRequestTabId) || null;
}

function updateRequestTabsOverflowControls() {
    const track = document.getElementById('requestTabsTrack');
    const leftBtn = document.getElementById('requestTabsNavLeft');
    const rightBtn = document.getElementById('requestTabsNavRight');
    if (!track || !leftBtn || !rightBtn) return;

    const hasOverflow = track.scrollWidth > track.clientWidth + 2;
    leftBtn.classList.toggle('hidden', !hasOverflow);
    rightBtn.classList.toggle('hidden', !hasOverflow);

    if (!hasOverflow) {
        leftBtn.disabled = true;
        rightBtn.disabled = true;
        return;
    }

    const atStart = track.scrollLeft <= 1;
    const atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 1;
    leftBtn.disabled = atStart;
    rightBtn.disabled = atEnd;
}

function ensureActiveTabVisible() {
    const track = document.getElementById('requestTabsTrack');
    const activeCard = document.querySelector('.request-tab-card.active');
    if (!track || !activeCard) return;

    const viewLeft = track.scrollLeft;
    const viewRight = viewLeft + track.clientWidth;
    const activeLeft = activeCard.offsetLeft;
    const activeRight = activeLeft + activeCard.offsetWidth;

    if (activeLeft < viewLeft + 6) {
        track.scrollTo({ left: Math.max(0, activeLeft - 12), behavior: 'smooth' });
        return;
    }

    if (activeRight > viewRight - 6) {
        track.scrollTo({ left: activeRight - track.clientWidth + 12, behavior: 'smooth' });
    }
}

function updateRequestTabsDropdownVisibility() {
    const dropdown = document.getElementById('requestTabsDropdown');
    const toggle = document.getElementById('requestTabMenuToggle');
    if (!dropdown || !toggle) return;

    dropdown.classList.toggle('hidden', !isRequestTabsDropdownVisible);
    toggle.classList.toggle('active', isRequestTabsDropdownVisible);
}

function hideRequestTabsDropdown(resetSearch = false) {
    isRequestTabsDropdownVisible = false;
    if (resetSearch) {
        requestTabsSearchQuery = '';
        const input = document.getElementById('requestTabsSearchInput');
        if (input) input.value = '';
    }
    updateRequestTabsDropdownVisibility();
}

function renderRequestTabsDropdown() {
    const list = document.getElementById('requestTabsDropdownList');
    if (!list) return;

    const keyword = requestTabsSearchQuery.trim().toLowerCase();
    const filteredTabs = requestTabs.filter((tab) => {
        if (!keyword) return true;
        const title = getRequestDisplayName(tab).toLowerCase();
        const url = (tab.url || '').toLowerCase();
        const method = (tab.method || 'GET').toLowerCase();
        return title.includes(keyword) || url.includes(keyword) || method.includes(keyword);
    });

    list.innerHTML = '';
    if (filteredTabs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'request-tabs-dropdown-empty';
        empty.textContent = 'No tabs matched';
        list.appendChild(empty);
        return;
    }

    filteredTabs.forEach((tab) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `request-tabs-dropdown-item ${tab.id === activeRequestTabId ? 'active' : ''}`;
        row.dataset.tabId = tab.id;

        const method = document.createElement('span');
        method.className = 'request-tabs-dropdown-method';
        method.textContent = tab.method || 'GET';

        const title = document.createElement('span');
        title.className = 'request-tabs-dropdown-title';
        title.textContent = getRequestDisplayName(tab);

        const dot = document.createElement('span');
        dot.className = `request-tabs-dropdown-dot ${isRequestTabReady(tab) ? 'ready' : ''}`;

        row.appendChild(method);
        row.appendChild(title);
        row.appendChild(dot);
        row.addEventListener('click', () => {
            activateTabById(tab.id);
            hideRequestTabsDropdown(false);
        });

        list.appendChild(row);
    });
}

window.scrollRequestTabs = function(direction) {
    const track = document.getElementById('requestTabsTrack');
    if (!track) return;

    const step = Math.max(180, Math.floor(track.clientWidth * 0.72));
    const delta = direction < 0 ? -step : step;
    track.scrollBy({ left: delta, behavior: 'smooth' });
    setTimeout(() => {
        updateRequestTabsOverflowControls();
    }, 220);
};

window.toggleRequestTabsDropdown = function(evt) {
    if (evt) {
        evt.preventDefault();
        evt.stopPropagation();
    }

    isRequestTabsDropdownVisible = !isRequestTabsDropdownVisible;
    if (!isRequestTabsDropdownVisible) {
        updateRequestTabsDropdownVisibility();
        return;
    }

    updateRequestTabsDropdownVisibility();
    renderRequestTabsDropdown();
    const input = document.getElementById('requestTabsSearchInput');
    if (input) {
        requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
    }
};

window.filterRequestTabsDropdown = function(query) {
    requestTabsSearchQuery = query || '';
    renderRequestTabsDropdown();
};

function renderRequestTabs() {
    const container = document.getElementById('requestTabsContainer');
    if (!container) return;

    container.innerHTML = '';
    requestTabs.forEach((tab) => {
        const isActive = tab.id === activeRequestTabId;
        const isReady = isRequestTabReady(tab);
        const card = document.createElement('div');
        card.className = `request-tab-card ${isActive ? 'active' : ''}`;
        card.onclick = () => switchRequestTab(tab.id);
        card.innerHTML = `
            <div class="request-tab-content">
                <div class="request-tab-meta"><span class="request-tab-method">${escapeHtml(tab.method || 'GET')}</span></div>
                <div class="request-tab-title">${escapeHtml(getRequestDisplayName(tab))}</div>
            </div>
            <div class="request-tab-actions">
                <span class="request-tab-status-dot ${isReady ? 'ready' : ''}" title="${isReady ? 'Ready to send' : 'Draft'}"></span>
                <button class="request-tab-close" type="button" title="Close Request Tab" onclick="closeRequestTab('${tab.id}', event)">×</button>
            </div>
        `;
        container.appendChild(card);
    });

    renderRequestTabsDropdown();
    requestAnimationFrame(() => {
        ensureActiveTabVisible();
        updateRequestTabsOverflowControls();
    });
}

window.createNewRequestTab = function() {
    syncCurrentRequestFromUI();
    const tab = createNewTabState();
    requestTabs.push(tab);
    activeRequestTabId = tab.id;
    currentRequest = tab;
    renderRequestTabs();
    applyCurrentRequestToUI();
};

window.closeRequestTab = function(tabId, evt) {
    if (evt) {
        evt.preventDefault();
        evt.stopPropagation();
    }

    syncCurrentRequestFromUI();
    const index = requestTabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return;

    const removingActive = requestTabs[index].id === activeRequestTabId;
    requestTabs.splice(index, 1);

    if (requestTabs.length === 0) {
        const newTab = createNewTabState();
        requestTabs = [newTab];
        activeRequestTabId = newTab.id;
        currentRequest = newTab;
        renderRequestTabs();
        applyCurrentRequestToUI();
        return;
    }

    if (removingActive) {
        const nextTab = requestTabs[Math.max(0, index - 1)] || requestTabs[0];
        activeRequestTabId = nextTab.id;
        currentRequest = nextTab;
        renderRequestTabs();
        applyCurrentRequestToUI();
        return;
    }

    renderRequestTabs();
};

function switchRequestTab(tabId) {
    if (tabId === activeRequestTabId) return;

    syncCurrentRequestFromUI();
    const target = requestTabs.find(tab => tab.id === tabId);
    if (!target) return;
    activeRequestTabId = tabId;
    currentRequest = target;
    renderRequestTabs();
    applyCurrentRequestToUI();
}

function syncAutoNameInputWithUrl() {
    const tab = getActiveTab();
    if (!tab || tab.isCustomName) return;

    const url = buildUrlWithQuery(document.getElementById('urlInput').value, collectQueryParams());
    const nameInput = document.getElementById('requestNameInput');
    nameInput.value = url;
}

function syncCurrentRequestFromUI() {
    const tab = getActiveTab();
    if (!tab) return;

    tab.method = document.getElementById('methodSelect').value;
    tab.url = buildUrlWithQuery(document.getElementById('urlInput').value, collectQueryParams());
    const rawNameInput = (document.getElementById('requestNameInput').value || '').trim();
    if (tab.isCustomName) {
        if (rawNameInput) {
            tab.name = rawNameInput;
        } else {
            tab.isCustomName = false;
            tab.name = tab.url || '';
        }
    } else {
        tab.name = tab.url || rawNameInput || '';
    }
    tab.queryParams = collectQueryParams();
    tab.headers = collectHeaders();
    tab.bodyType = getSelectedBodyType();
    tab.rawFormat = getSelectedRawFormat();
    tab.body = document.getElementById('bodyEditor')?.value || '';
    tab.bodyFields = collectBodyFields();
    tab.binaryBody = document.getElementById('bodyBinaryEditor')?.value || '';
    tab.graphqlQuery = document.getElementById('graphqlQueryEditor')?.value || '';
    tab.graphqlVariables = document.getElementById('graphqlVariablesEditor')?.value || '{}';
    currentRequest = tab;
}

function applyCurrentRequestToUI() {
    const tab = getActiveTab();
    if (!tab) return;

    currentRequest = normalizeRequest(tab);
    Object.assign(tab, currentRequest);

    document.getElementById('methodSelect').value = currentRequest.method;
    document.getElementById('urlInput').value = currentRequest.url;
    document.getElementById('requestNameInput').value = currentRequest.name || currentRequest.url || '';
    const rawFormatSelect = document.getElementById('rawFormatSelect');
    if (rawFormatSelect) {
        rawFormatSelect.value = currentRequest.rawFormat || 'json';
    }
    document.getElementById('bodyEditor').value = currentRequest.body || '';
    document.getElementById('bodyBinaryEditor').value = currentRequest.binaryBody || '';
    document.getElementById('graphqlQueryEditor').value = currentRequest.graphqlQuery || '';
    document.getElementById('graphqlVariablesEditor').value = currentRequest.graphqlVariables || '{}';

    document.getElementById('queryParamsBody').innerHTML = '';
    document.getElementById('headersBody').innerHTML = '';
    currentRequest.queryParams.forEach((param) => {
        addQueryParam(param.key, param.value, param.description || '', param.enabled !== false);
    });
    if (currentRequest.queryParams.length === 0) addQueryParam();

    currentRequest.headers.forEach((header) => {
        addHeader(header.key, header.value, header.description || '', header.enabled !== false);
    });
    if (currentRequest.headers.length === 0) addHeader();

    applyBodyFields(currentRequest.bodyFields);
    switchRequestBodyType(currentRequest.bodyType || 'none');
    updateBadges();
    renderRequestTabs();
}

function attachRequestMetaListeners() {
    const methodSelect = document.getElementById('methodSelect');
    const urlInput = document.getElementById('urlInput');
    const nameInput = document.getElementById('requestNameInput');
    const rawFormatSelect = document.getElementById('rawFormatSelect');

    methodSelect.addEventListener('change', () => {
        syncCurrentRequestFromUI();
        renderRequestTabs();
    });

    urlInput.addEventListener('input', () => {
        const tab = getActiveTab();
        const nameInput = document.getElementById('requestNameInput');
        if (tab && !tab.isCustomName) {
            nameInput.value = buildUrlWithQuery(urlInput.value, collectQueryParams());
        }
        syncCurrentRequestFromUI();
        renderRequestTabs();
    });

    nameInput.addEventListener('input', () => {
        const tab = getActiveTab();
        if (tab) {
            const typedName = (nameInput.value || '').trim();
            const currentUrl = buildUrlWithQuery(urlInput.value, collectQueryParams());
            tab.isCustomName = !!typedName && typedName !== currentUrl;
        }
        syncCurrentRequestFromUI();
        renderRequestTabs();
    });

    if (rawFormatSelect) {
        rawFormatSelect.addEventListener('change', () => {
            syncCurrentRequestFromUI();
        });
    }
}

// ==================== URL 与 Query 参数双向联动 ====================
function initUrlSync() {
    const urlInput = document.getElementById('urlInput');
    
    // URL 变化时解析到表格
    urlInput.addEventListener('input', () => {
        if (isUpdatingUrl) return;
        parseUrlToParams();
    });
    
    // 监听 Query 参数表格变化
    const queryParamsBody = document.getElementById('queryParamsBody');
    queryParamsBody.addEventListener('input', (e) => {
        if (e.target.classList.contains('param-input')) {
            syncParamsToUrl();
        }
    });
    queryParamsBody.addEventListener('change', (e) => {
        if (e.target.classList.contains('param-checkbox')) {
            syncParamsToUrl();
        }
    });
}

// 从 URL 解析 Query 参数到表格
function parseUrlToParams() {
    if (isUpdatingParams) return;
    
    const urlInput = document.getElementById('urlInput');
    const fullUrl = urlInput.value.trim();
    
    if (!fullUrl) return;
    
    try {
        let baseUrl = fullUrl;
        let queryString = '';
        
        const questionMarkIndex = fullUrl.indexOf('?');
        if (questionMarkIndex > -1) {
            baseUrl = fullUrl.substring(0, questionMarkIndex);
            queryString = fullUrl.substring(questionMarkIndex + 1);
        }
        
        if (!queryString) return;
        
        isUpdatingParams = true;
        
        // 清空现有参数
        const queryParamsBody = document.getElementById('queryParamsBody');
        queryParamsBody.innerHTML = '';
        
        // 解析 query string
        const params = new URLSearchParams(queryString);
        let hasParams = false;
        
        for (const [key, value] of params.entries()) {
            if (key) {
                addQueryParam(key, value, '', true);
                hasParams = true;
            }
        }
        
        // 更新 URL 为不带参数的
        if (hasParams) {
            urlInput.value = baseUrl;
        }

        syncAutoNameInputWithUrl();
        
        updateBadges();
        
        setTimeout(() => {
            isUpdatingParams = false;
        }, 0);
    } catch (error) {
        console.error('Parse URL error:', error);
        isUpdatingParams = false;
    }
}

// 从表格同步 Query 参数到 URL
function syncParamsToUrl() {
    if (isUpdatingParams) return;
    
    isUpdatingUrl = true;
    
    const urlInput = document.getElementById('urlInput');
    let baseUrl = urlInput.value.trim();
    
    // 移除现有参数
    const questionMarkIndex = baseUrl.indexOf('?');
    if (questionMarkIndex > -1) {
        baseUrl = baseUrl.substring(0, questionMarkIndex);
    }
    
    // 收集启用的参数
    const params = collectQueryParams();
    const enabledParams = params.filter(p => p.enabled && p.key);
    
    // 构建新 URL
    if (enabledParams.length > 0) {
        const queryString = enabledParams
            .map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
            .join('&');
        urlInput.value = `${baseUrl}?${queryString}`;
    } else {
        urlInput.value = baseUrl;
    }

    syncAutoNameInputWithUrl();
    
    updateBadges();
    
    setTimeout(() => {
        isUpdatingUrl = false;
    }, 0);
}

// ==================== 侧边栏切换 ====================
window.switchSidebar = function(tab, evt) {
    document.querySelectorAll('.icon-sidebar .icon-item').forEach(t => t.classList.remove('active'));
    const target = getEventTarget(evt);
    if (target) {
        target.classList.add('active');
    }

    const sidebar = document.getElementById('sidebar');
    if (sidebar.classList.contains('collapsed') || sidebar.getBoundingClientRect().width < 8) {
        sidebar.classList.remove('collapsed');
        sidebar.style.width = '280px';
    }
    
    document.getElementById('collectionsPanel').classList.add('hidden');
    document.getElementById('historyPanel').classList.add('hidden');
    
    document.getElementById(tab + 'Panel').classList.remove('hidden');
};

// ==================== Collections 管理 ====================
async function loadCollections() {
    try {
        const data = await invoke('get_collections');
        collections = data || [];
        renderCollections();
    } catch (error) {
        console.error('Load collections error:', error);
        // 使用默认数据
        collections = [
            {
                id: '1',
                name: 'chat',
                type: 'folder',
                children: [
                    { id: '1-1', name: '获取消息列表', method: 'GET', url: '/api/chat/messages' },
                    { id: '1-2', name: '发送消息', method: 'POST', url: '/api/chat/send' }
                ]
            },
            {
                id: '2',
                name: 'common',
                type: 'folder',
                children: [
                    { id: '2-1', name: '获取配置', method: 'GET', url: '/api/config' }
                ]
            }
        ];
        renderCollections();
    }
}

function renderCollections() {
    const panel = document.getElementById('collectionsContent');
    panel.innerHTML = '';
    
    collections.forEach(folder => {
        const folderEl = document.createElement('div');
        folderEl.innerHTML = `
            <div class="tree-item tree-folder" onclick="toggleFolder(this)">
                <span class="icon">▼</span>
                <span>📁 ${folder.name}</span>
            </div>
            <div class="tree-children">
                ${folder.children.map(child => `
                    <div class="tree-item" onclick="selectCollectionRequest('${child.id}')">
                        <span class="method-badge method-${child.method}">${child.method}</span>
                        <span>${child.name}</span>
                    </div>
                `).join('')}
            </div>
        `;
        panel.appendChild(folderEl);
    });
}

window.toggleFolder = function(element) {
    const icon = element.querySelector('.icon');
    const children = element.nextElementSibling;
    
    if (children && children.classList.contains('tree-children')) {
        if (children.style.display === 'none') {
            children.style.display = 'block';
            icon.textContent = '▼';
        } else {
            children.style.display = 'none';
            icon.textContent = '▶';
        }
    }
};

window.selectCollectionRequest = function(id) {
    // 查找请求
    let request = null;
    collections.forEach(folder => {
        const found = folder.children.find(c => c.id === id);
        if (found) request = found;
    });
    
    if (!request) return;

    let requestData = {};
    if (request.request_data) {
        try {
            requestData = JSON.parse(request.request_data);
        } catch {
            requestData = {};
        }
    }

    const payload = normalizeRequest({
        ...requestData,
        name: request.name || requestData.name || '',
        method: request.method || requestData.method || 'GET',
        url: request.url || requestData.url || '',
        queryParams: requestData.queryParams || [],
        headers: requestData.headers || [],
        body: requestData.body || '',
        bodyType: requestData.bodyType || 'none',
        rawFormat: requestData.rawFormat || 'json',
        bodyFields: requestData.bodyFields || [],
        binaryBody: requestData.binaryBody || '',
        graphqlQuery: requestData.graphqlQuery || '',
        graphqlVariables: requestData.graphqlVariables || '{}'
    });

    openRequestFromSource('collection', id, payload);
};

// ==================== History 管理 ====================
async function loadHistory() {
    try {
        const records = await invoke('get_history');
        history = records || [];
        renderHistory();
    } catch (error) {
        console.error('Load history error:', error);
        history = [];
        renderHistory();
    }
}

function renderHistory() {
    const panel = document.getElementById('historyContent');
    panel.innerHTML = '';
    
    if (history.length === 0) {
        panel.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🕐</div>
                <div>No history yet</div>
            </div>
        `;
        return;
    }
    
    // 按日期分组
    const groups = {};
    history.forEach(item => {
        const date = formatDateGroup(item.timestamp);
        if (!groups[date]) groups[date] = [];
        groups[date].push(item);
    });
    
    // 按日期倒序渲染
    Object.keys(groups).sort().reverse().forEach(date => {
        const groupEl = document.createElement('div');
        groupEl.className = 'history-date-group';
        
        groupEl.innerHTML = `
            <div class="history-date-header">${date}</div>
            ${groups[date].map(item => `
                <div class="history-item ${item.id === currentHistoryId ? 'active' : ''}" 
                     onclick="loadHistoryItem(${item.id})">
                    <span class="method-badge method-${item.method}">${item.method}</span>
                    <span class="url">${truncateUrl(item.url)}</span>
                    <span class="time">${formatTime(item.timestamp)}</span>
                </div>
            `).join('')}
        `;
        
        panel.appendChild(groupEl);
    });
}

window.loadHistoryItem = async function(id) {
    try {
        const item = history.find(h => h.id === id);
        if (!item) return;
        
        currentHistoryId = id;
        
        let parsedRequest = {};
        try {
            parsedRequest = JSON.parse(item.request_data || '{}');
        } catch {
            parsedRequest = {};
        }

        const requestData = normalizeRequest(parsedRequest);
        openRequestFromSource('history', id, requestData);
        
        // 显示响应
        if (item.response_data) {
            const response = JSON.parse(item.response_data);
            displayResponse(response);
        }
        
        renderHistory();
        updateBadges();
    } catch (error) {
        console.error('Load history item error:', error);
    }
};

// ==================== 标签页切换 ====================
window.switchTab = function(tab, evt) {
    document.querySelectorAll('.tabs .tab').forEach(t => t.classList.remove('active'));
    const target = getEventTarget(evt);
    if (target) {
        target.classList.add('active');
    }
    
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    document.getElementById(tab + 'Panel').classList.remove('hidden');
};

window.switchResponseTab = function(tab) {
    switchResponseView(tab);
};

window.switchResponseView = function(view) {
    if (!['body', 'headers', 'cookies'].includes(view)) {
        return;
    }

    currentResponseView = view;
    document.querySelectorAll('.response-view-tab').forEach((tab) => {
        tab.classList.toggle('active', tab.dataset.view === view);
    });

    if (view !== 'body' && isBodySearchVisible) {
        hideBodySearch(true);
    }

    updateResponsePanels();
    if (view === 'body') renderResponseBody();
};

window.switchBodyFormat = function(format) {
    const validFormats = ['json', 'xml', 'html', 'javascript', 'raw', 'hex', 'base64'];
    if (!validFormats.includes(format)) {
        return;
    }

    currentBodyFormat = format;
    const bodyFormatSelect = document.getElementById('bodyFormatSelect');
    if (bodyFormatSelect && bodyFormatSelect.value !== format) {
        bodyFormatSelect.value = format;
    }

    if (!canPreviewCurrentBody()) isBodyPreview = false;
    if (currentBodyFormat !== 'json') isBodyVisualize = false;

    updatePreviewButtonState();
    updateVisualizeButtonState();
    renderResponseBody();
};

window.toggleBodyPreview = function() {
    if (!canPreviewCurrentBody()) {
        showToast('Preview is available for HTML and image responses', 'error');
        return;
    }

    isBodyPreview = !isBodyPreview;
    if (isBodyPreview) isBodyVisualize = false;
    updatePreviewButtonState();
    updateVisualizeButtonState();
    renderResponseBody();
};

window.toggleBodyVisualize = function() {
    if (currentBodyFormat !== 'json' || !hasJsonBody()) {
        showToast('Visualize only supports valid JSON', 'error');
        return;
    }

    isBodyVisualize = !isBodyVisualize;
    if (isBodyVisualize) isBodyPreview = false;
    updatePreviewButtonState();
    updateVisualizeButtonState();
    renderResponseBody();
};

window.updateBodySearch = function(query) {
    bodySearchQuery = query || '';
    bodySearchIndex = 0;
    renderResponseBody();
};

window.gotoBodySearchPrev = function() {
    navigateBodySearch(-1);
};

window.gotoBodySearchNext = function() {
    navigateBodySearch(1);
};

window.closeBodySearch = function() {
    hideBodySearch(true);
};

function showBodySearch() {
    isBodySearchVisible = true;
    updateSearchVisibility();
    const input = document.getElementById('bodySearchInput');
    input.focus();
    input.select();
}

function hideBodySearch(clearQuery = false) {
    isBodySearchVisible = false;
    updateSearchVisibility();

    if (clearQuery) {
        bodySearchQuery = '';
        bodySearchIndex = 0;
        const input = document.getElementById('bodySearchInput');
        input.value = '';
        renderResponseBody();
    } else {
        updateSearchMeta(0, 0);
    }
}

function navigateBodySearch(direction) {
    if (!bodySearchQuery) return;
    if (currentResponseView !== 'body') return;

    const marks = Array.from(document.querySelectorAll('#responseBodyContent mark.search-hit'));
    if (marks.length === 0) return;

    bodySearchIndex = (bodySearchIndex + direction + marks.length) % marks.length;
    syncBodySearchMarks(true);
}

function updateResponsePanels() {
    document.getElementById('responseBody').classList.toggle('hidden', currentResponseView !== 'body');
    document.getElementById('responseHeaders').classList.toggle('hidden', currentResponseView !== 'headers');
    document.getElementById('responseCookies').classList.toggle('hidden', currentResponseView !== 'cookies');

    const bodyViewTools = document.getElementById('bodyViewTools');
    bodyViewTools.classList.toggle('hidden', currentResponseView !== 'body');

    updateSearchVisibility();
}

function updatePreviewButtonState() {
    const previewBtn = document.getElementById('bodyPreviewBtn');
    if (!previewBtn) return;

    const supportsPreview = canPreviewCurrentBody();
    if (!supportsPreview) isBodyPreview = false;

    previewBtn.disabled = !supportsPreview;
    previewBtn.classList.toggle('active', supportsPreview && isBodyPreview);
}

function updateVisualizeButtonState() {
    const visualizeBtn = document.getElementById('bodyVisualizeBtn');
    if (!visualizeBtn) return;

    const supportsVisualize = currentBodyFormat === 'json' && hasJsonBody();
    if (!supportsVisualize) isBodyVisualize = false;

    visualizeBtn.disabled = !supportsVisualize;
    visualizeBtn.classList.toggle('active', supportsVisualize && isBodyVisualize);
}

function updateSearchVisibility() {
    const search = document.getElementById('bodySearchFloating');
    if (!search) return;

    const show = isBodySearchVisible && currentResponseView === 'body';
    search.classList.toggle('hidden', !show);
}

function updateSearchMeta(current, total) {
    const meta = document.getElementById('bodySearchMeta');
    const prevBtn = document.getElementById('bodySearchPrevBtn');
    const nextBtn = document.getElementById('bodySearchNextBtn');
    meta.textContent = `${current} / ${total}`;

    const disabled = total === 0;
    prevBtn.disabled = disabled;
    nextBtn.disabled = disabled;
}

function syncBodySearchMarks(scrollToActive = false) {
    const marks = Array.from(document.querySelectorAll('#responseBodyContent mark.search-hit'));
    if (marks.length === 0) {
        updateSearchMeta(0, 0);
        return;
    }

    if (bodySearchIndex >= marks.length) bodySearchIndex = marks.length - 1;
    if (bodySearchIndex < 0) bodySearchIndex = 0;

    marks.forEach((mark, index) => {
        mark.classList.toggle('search-hit-active', index === bodySearchIndex);
    });

    updateSearchMeta(bodySearchIndex + 1, marks.length);

    if (scrollToActive) {
        marks[bodySearchIndex].scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }
}

// ==================== Query 参数管理 ====================
window.addQueryParam = function(key = '', value = '', description = '', enabled = true) {
    const tbody = document.getElementById('queryParamsBody');
    
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="checkbox" class="param-checkbox" ${enabled ? 'checked' : ''} /></td>
        <td><input type="text" class="param-input key" placeholder="Key" value="${escapeHtml(key)}" /></td>
        <td><input type="text" class="param-input value" placeholder="Value" value="${escapeHtml(value)}" /></td>
        <td><input type="text" class="param-input description" placeholder="Description" value="${escapeHtml(description)}" /></td>
        <td><button class="btn-delete" onclick="deleteParamRow(this)">×</button></td>
    `;
    tbody.appendChild(tr);
    
    // 添加输入监听
    const inputs = tr.querySelectorAll('.param-input');
    inputs.forEach(input => {
        input.addEventListener('input', () => {
            syncParamsToUrl();
        });
    });
    
    const checkbox = tr.querySelector('.param-checkbox');
    checkbox.addEventListener('change', () => {
        syncParamsToUrl();
    });
    
    updateBadges();
};

function collectQueryParams() {
    const tbody = document.getElementById('queryParamsBody');
    const params = [];
    
    tbody.querySelectorAll('tr').forEach(tr => {
        const inputs = tr.querySelectorAll('.param-input');
        const checkbox = tr.querySelector('.param-checkbox');
        
        if (inputs[0].value || inputs[1].value) {
            params.push({
                key: inputs[0].value,
                value: inputs[1].value,
                description: inputs[2].value,
                enabled: checkbox.checked
            });
        }
    });
    
    return params;
}

window.deleteParamRow = function(btn) {
    btn.closest('tr').remove();
    syncParamsToUrl();
    updateBadges();
};

// ==================== Headers 管理 ====================
window.addHeader = function(key = '', value = '', description = '', enabled = true) {
    const tbody = document.getElementById('headersBody');
    
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="checkbox" class="param-checkbox" ${enabled ? 'checked' : ''} /></td>
        <td><input type="text" class="param-input key" placeholder="Key" value="${escapeHtml(key)}" /></td>
        <td><input type="text" class="param-input value" placeholder="Value" value="${escapeHtml(value)}" /></td>
        <td><input type="text" class="param-input description" placeholder="Description" value="${escapeHtml(description)}" /></td>
        <td><button class="btn-delete" onclick="deleteHeaderRow(this)">×</button></td>
    `;
    tbody.appendChild(tr);

    const inputs = tr.querySelectorAll('.param-input');
    inputs.forEach(input => {
        input.addEventListener('input', () => {
            updateBadges();
        });
    });

    const checkbox = tr.querySelector('.param-checkbox');
    checkbox.addEventListener('change', () => {
        updateBadges();
    });
    
    updateBadges();
};

function collectHeaders() {
    const tbody = document.getElementById('headersBody');
    const headers = [];
    
    tbody.querySelectorAll('tr').forEach(tr => {
        const inputs = tr.querySelectorAll('.param-input');
        const checkbox = tr.querySelector('.param-checkbox');
        
        if (inputs[0].value) {
            headers.push({
                key: inputs[0].value,
                value: inputs[1].value,
                description: inputs[2].value,
                enabled: checkbox.checked
            });
        }
    });
    
    return headers;
}

window.deleteHeaderRow = function(btn) {
    btn.closest('tr').remove();
    updateBadges();
};

// ==================== Body 类型管理 ====================
function getSelectedBodyType() {
    const selected = document.querySelector('input[name="bodyType"]:checked');
    return selected ? selected.value : 'none';
}

function getSelectedRawFormat() {
    const rawFormatSelect = document.getElementById('rawFormatSelect');
    if (!rawFormatSelect) return 'json';
    const format = rawFormatSelect.value || 'json';
    const supported = ['text', 'javascript', 'json', 'html', 'xml'];
    return supported.includes(format) ? format : 'json';
}

function getRawContentType(rawFormat) {
    const mapping = {
        text: 'text/plain',
        javascript: 'application/javascript',
        json: 'application/json',
        html: 'text/html',
        xml: 'application/xml'
    };
    return mapping[rawFormat] || 'application/json';
}

window.switchRequestBodyType = function(bodyType) {
    const sections = {
        'none': 'bodyNoneSection',
        'form-data': 'bodyKeyValueSection',
        'x-www-form-urlencoded': 'bodyKeyValueSection',
        'raw': 'bodyRawSection',
        'binary': 'bodyBinarySection',
        'graphql': 'bodyGraphqlSection'
    };

    document.querySelectorAll('input[name="bodyType"]').forEach((radio) => {
        radio.checked = radio.value === bodyType;
    });

    ['bodyNoneSection', 'bodyKeyValueSection', 'bodyRawSection', 'bodyBinarySection', 'bodyGraphqlSection']
        .forEach((id) => document.getElementById(id).classList.add('hidden'));

    const visibleSection = sections[bodyType] || 'bodyNoneSection';
    document.getElementById(visibleSection).classList.remove('hidden');
    document.getElementById('rawFormatWrap').classList.toggle('hidden', bodyType !== 'raw');

    syncCurrentRequestFromUI();
};

window.addBodyField = function(key = '', value = '', description = '', enabled = true) {
    const tbody = document.getElementById('bodyKeyValueBody');
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="checkbox" class="param-checkbox" ${enabled ? 'checked' : ''} /></td>
        <td><input type="text" class="param-input key" placeholder="Key" value="${escapeHtml(key)}" /></td>
        <td><input type="text" class="param-input value" placeholder="Value" value="${escapeHtml(value)}" /></td>
        <td><input type="text" class="param-input description" placeholder="Description" value="${escapeHtml(description)}" /></td>
        <td><button class="btn-delete" onclick="deleteBodyField(this)">×</button></td>
    `;
    tbody.appendChild(tr);

    tr.querySelectorAll('.param-input').forEach((input) => {
        input.addEventListener('input', () => {
            syncCurrentRequestFromUI();
        });
    });
    tr.querySelector('.param-checkbox').addEventListener('change', () => {
        syncCurrentRequestFromUI();
    });
};

window.deleteBodyField = function(btn) {
    btn.closest('tr').remove();
    syncCurrentRequestFromUI();
};

function collectBodyFields() {
    const tbody = document.getElementById('bodyKeyValueBody');
    const fields = [];
    tbody.querySelectorAll('tr').forEach((tr) => {
        const inputs = tr.querySelectorAll('.param-input');
        const checkbox = tr.querySelector('.param-checkbox');
        if (inputs[0].value || inputs[1].value) {
            fields.push({
                key: inputs[0].value,
                value: inputs[1].value,
                description: inputs[2].value,
                enabled: checkbox.checked
            });
        }
    });
    return fields;
}

function applyBodyFields(fields = []) {
    const tbody = document.getElementById('bodyKeyValueBody');
    tbody.innerHTML = '';
    fields.forEach((field) => {
        addBodyField(field.key, field.value, field.description || '', field.enabled !== false);
    });
    if (fields.length === 0) addBodyField();
}

function collectRequestBodyPayload() {
    const bodyType = getSelectedBodyType();
    const payload = {
        bodyType,
        body: null,
        bodyBase64: null,
        extraHeaders: {}
    };

    if (bodyType === 'none') return payload;

    if (bodyType === 'raw') {
        payload.body = document.getElementById('bodyEditor').value || '';
        payload.extraHeaders['Content-Type'] = getRawContentType(getSelectedRawFormat());
        return payload;
    }

    if (bodyType === 'x-www-form-urlencoded') {
        const encoded = collectBodyFields()
            .filter((field) => field.enabled && field.key)
            .map((field) => `${encodeURIComponent(field.key)}=${encodeURIComponent(field.value || '')}`)
            .join('&');
        payload.body = encoded;
        payload.extraHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
        return payload;
    }

    if (bodyType === 'form-data') {
        const boundary = `----LocalPostman${Date.now().toString(16)}`;
        const lines = [];
        collectBodyFields()
            .filter((field) => field.enabled && field.key)
            .forEach((field) => {
                lines.push(`--${boundary}`);
                lines.push(`Content-Disposition: form-data; name="${field.key}"`);
                lines.push('');
                lines.push(field.value || '');
            });
        lines.push(`--${boundary}--`);
        payload.body = lines.join('\r\n');
        payload.extraHeaders['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
        return payload;
    }

    if (bodyType === 'binary') {
        const binaryText = (document.getElementById('bodyBinaryEditor').value || '').trim();
        if (binaryText && !isValidBase64(binaryText)) {
            throw new Error('Binary body must be valid base64 content');
        }
        payload.bodyBase64 = binaryText || null;
        payload.extraHeaders['Content-Type'] = 'application/octet-stream';
        return payload;
    }

    if (bodyType === 'graphql') {
        const query = document.getElementById('graphqlQueryEditor').value || '';
        const rawVariables = (document.getElementById('graphqlVariablesEditor').value || '').trim();
        let variables = {};
        if (rawVariables) {
            try {
                variables = JSON.parse(rawVariables);
            } catch {
                throw new Error('GraphQL variables must be valid JSON');
            }
        }
        payload.body = JSON.stringify({ query, variables });
        payload.extraHeaders['Content-Type'] = 'application/json';
        return payload;
    }

    return payload;
}

// ==================== 徽章更新 ====================
function updateBadges() {
    const queryParams = collectQueryParams();
    const enabledQueryParams = queryParams.filter(p => p.enabled && p.key).length;
    document.getElementById('paramsBadge').textContent = enabledQueryParams;
    
    const headers = collectHeaders();
    const enabledHeaders = headers.filter(h => h.enabled && h.key).length;
    document.getElementById('headersBadge').textContent = enabledHeaders;
}

// ==================== 发送请求 ====================
window.sendRequest = async function() {
    const sendBtn = document.getElementById('sendBtn');
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending...';
    
    try {
        // 收集请求数据
        currentRequest.method = document.getElementById('methodSelect').value;
        currentRequest.queryParams = collectQueryParams();
        currentRequest.url = buildUrlWithQuery(document.getElementById('urlInput').value, currentRequest.queryParams);
        currentRequest.name = (document.getElementById('requestNameInput').value || '').trim() || currentRequest.url;
        currentRequest.headers = collectHeaders();
        const bodyPayload = collectRequestBodyPayload();
        currentRequest.bodyType = bodyPayload.bodyType;
        currentRequest.rawFormat = getSelectedRawFormat();
        currentRequest.body = document.getElementById('bodyEditor').value || '';
        currentRequest.bodyFields = collectBodyFields();
        currentRequest.binaryBody = document.getElementById('bodyBinaryEditor').value || '';
        currentRequest.graphqlQuery = document.getElementById('graphqlQueryEditor').value || '';
        currentRequest.graphqlVariables = document.getElementById('graphqlVariablesEditor').value || '{}';
        syncCurrentRequestFromUI();
        renderRequestTabs();
        
        if (!currentRequest.url) {
            alert('Please enter a URL');
            return;
        }
        
        // 构建请求头
        const headers = {};
        currentRequest.headers
            .filter(h => h.enabled)
            .forEach(h => headers[h.key] = h.value);

        Object.entries(bodyPayload.extraHeaders).forEach(([key, value]) => {
            if (!headers[key]) headers[key] = value;
        });
        
        // 发送请求
        const requestData = {
            method: currentRequest.method,
            url: currentRequest.url,
            headers: Object.entries(headers),
            body: bodyPayload.body,
            body_base64: bodyPayload.bodyBase64
        };
        
        const responseData = await invoke('send_http_request', { request: requestData });
        
        // 显示响应
        displayResponse(responseData);
        
        // 保存到历史
        await saveToHistory(currentRequest, responseData);
        
    } catch (error) {
        console.error('Request error:', error);
        const message = error?.message || String(error);
        latestResponseData = { body: message, headers: {}, body_base64: null };
        currentBodyFormat = 'raw';
        isBodyPreview = false;
        isBodyVisualize = false;
        updatePreviewButtonState();
        updateVisualizeButtonState();
        document.getElementById('statusCode').textContent = 'Error';
        document.getElementById('statusCode').className = 'status-code status-error';
        document.getElementById('responseTime').textContent = '-- ms';
        document.getElementById('responseSize').textContent = '-- B';
        switchResponseView('body');
        renderResponseBody();
    } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
    }
};

// ==================== 显示响应 ====================
function displayResponse(data) {
    latestResponseData = data;

    // 状态码
    const statusCode = document.getElementById('statusCode');
    statusCode.textContent = `${data.status} ${data.status_text}`;
    statusCode.className = 'status-code ' + 
        (data.status < 300 ? 'status-success' : 
         data.status < 500 ? 'status-warning' : 'status-error');
    
    // 时间和大小
    document.getElementById('responseTime').textContent = `${data.duration} ms`;
    document.getElementById('responseSize').textContent = formatSize(data.size);

    const inferredFormat = inferResponseBodyFormat(data);
    currentBodyFormat = inferredFormat;
    isBodyPreview = false;
    isBodyVisualize = false;

    const bodyFormatSelect = document.getElementById('bodyFormatSelect');
    if (bodyFormatSelect) {
        bodyFormatSelect.value = inferredFormat;
    }

    updatePreviewButtonState();
    updateVisualizeButtonState();
    renderResponseHeaders(data.headers || {});
    renderResponseCookies(data.headers || {});
    switchResponseView('body');
    renderResponseBody();
}

function inferResponseBodyFormat(data) {
    const contentType = getHeaderValueIgnoreCase(data.headers || {}, 'content-type').toLowerCase();
    const body = (data.body || '').trim();

    if (contentType.includes('json') || contentType.includes('+json')) {
        return 'json';
    }
    if (contentType.includes('html')) {
        return 'html';
    }
    if (contentType.includes('xml')) {
        return 'xml';
    }
    if (contentType.includes('javascript') || contentType.includes('ecmascript')) {
        return 'javascript';
    }
    if (contentType.startsWith('image/')) {
        return 'raw';
    }

    if (body) {
        try {
            JSON.parse(body);
            return 'json';
        } catch {}
    }

    if (/^<!doctype html/i.test(body) || /^<html/i.test(body)) {
        return 'html';
    }
    if (/^<\?xml/i.test(body) || (/^</.test(body) && />$/.test(body))) {
        return 'xml';
    }

    return 'raw';
}

function renderResponseBody() {
    const responseBodyContent = getResponseBodyContent();
    if (!latestResponseData) {
        responseBodyContent.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📡</div>
                <div>Click Send to get a response</div>
            </div>
        `;
        updateSearchMeta(0, 0);
        return;
    }

    if (isBodyVisualize) {
        renderJsonVisualizedBody(responseBodyContent);
        return;
    }

    if (isBodyPreview) {
        if (renderPreviewBody(responseBodyContent)) return;
        isBodyPreview = false;
        updatePreviewButtonState();
    }

    const displayText = getBodyTextForCurrentFormat();
    if (bodySearchQuery) {
        responseBodyContent.innerHTML = `<pre>${highlightSearchText(displayText, bodySearchQuery)}</pre>`;
        syncBodySearchMarks();
        return;
    }

    if (currentBodyFormat === 'json') {
        try {
            const json = JSON.parse(latestResponseData.body || '');
            responseBodyContent.innerHTML = `<pre>${syntaxHighlight(json)}</pre>`;
            updateSearchMeta(0, 0);
            return;
        } catch {}
    }

    responseBodyContent.innerHTML = `<pre>${escapeHtml(displayText)}</pre>`;
    updateSearchMeta(0, 0);
}

function renderPreviewBody(container) {
    const contentType = getResponseContentType();
    const body = latestResponseData?.body || '';

    if (currentBodyFormat === 'html') {
        container.innerHTML = '<iframe class="response-preview-frame" id="responsePreviewFrame"></iframe>';
        const previewFrame = document.getElementById('responsePreviewFrame');
        previewFrame.srcdoc = body;
        updateSearchMeta(0, 0);
        return true;
    }

    if (contentType.startsWith('image/')) {
        const bodyBase64 = getResponseBodyBase64();
        if (!bodyBase64) return false;

        container.innerHTML = `<img class="response-preview-image" src="data:${escapeHtml(contentType)};base64,${bodyBase64}" alt="Response preview" />`;
        updateSearchMeta(0, 0);
        return true;
    }

    return false;
}

function renderJsonVisualizedBody(container) {
    let json;
    try {
        json = JSON.parse(latestResponseData?.body || '');
    } catch {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">⚠️</div>
                <div>JSON visualize is unavailable for this response</div>
            </div>
        `;
        updateSearchMeta(0, 0);
        return;
    }

    const rows = [];
    flattenJson(json, '$', rows, 0);
    let filteredRows = rows;
    if (bodySearchQuery) {
        const q = bodySearchQuery.toLowerCase();
        filteredRows = rows.filter((row) =>
            row.path.toLowerCase().includes(q) ||
            row.type.toLowerCase().includes(q) ||
            row.value.toLowerCase().includes(q)
        );
    }

    if (filteredRows.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🔍</div>
                <div>No matched fields in JSON visualize</div>
            </div>
        `;
        updateSearchMeta(0, 0);
        return;
    }

    let html = `
        <table class="response-json-table">
            <thead>
                <tr>
                    <th>Path</th>
                    <th>Type</th>
                    <th>Value</th>
                </tr>
            </thead>
            <tbody>
    `;

    filteredRows.forEach((row) => {
        html += `
            <tr>
                <td>${escapeHtml(row.path)}</td>
                <td>${escapeHtml(row.type)}</td>
                <td>${escapeHtml(row.value)}</td>
            </tr>
        `;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
    updateSearchMeta(0, 0);
}

function renderResponseHeaders(headers) {
    const responseHeaders = document.getElementById('responseHeaders');
    const entries = Object.entries(headers || {});
    if (entries.length === 0) {
        responseHeaders.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📭</div>
                <div>No headers received</div>
            </div>
        `;
        return;
    }

    let headersHtml = '<table class="params-table"><tbody>';
    for (const [key, value] of entries) {
        headersHtml += `
            <tr>
                <td style="color: #d73a49; font-weight: 500;">${escapeHtml(key)}</td>
                <td>${escapeHtml(value)}</td>
            </tr>
        `;
    }
    headersHtml += '</tbody></table>';
    responseHeaders.innerHTML = headersHtml;
}

function renderResponseCookies(headers) {
    const responseCookies = document.getElementById('responseCookies');
    const setCookie = getHeaderValueIgnoreCase(headers || {}, 'set-cookie');

    if (!setCookie) {
        responseCookies.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🍪</div>
                <div>No cookies received</div>
            </div>
        `;
        return;
    }

    const rows = String(setCookie).split(/\r?\n/).filter(Boolean);
    let cookiesHtml = `
        <table class="params-table">
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Value</th>
                    <th>Raw</th>
                </tr>
            </thead>
            <tbody>
    `;

    rows.forEach((cookieLine) => {
        const firstPart = cookieLine.split(';')[0] || '';
        const separatorIndex = firstPart.indexOf('=');
        const name = separatorIndex > -1 ? firstPart.substring(0, separatorIndex).trim() : firstPart.trim();
        const value = separatorIndex > -1 ? firstPart.substring(separatorIndex + 1).trim() : '';

        cookiesHtml += `
            <tr>
                <td>${escapeHtml(name)}</td>
                <td>${escapeHtml(value)}</td>
                <td>${escapeHtml(cookieLine)}</td>
            </tr>
        `;
    });

    cookiesHtml += '</tbody></table>';
    responseCookies.innerHTML = cookiesHtml;
}

function getResponseBodyContent() {
    const content = document.getElementById('responseBodyContent');
    if (!content) {
        throw new Error('responseBodyContent element not found');
    }
    return content;
}

function getHeaderValueIgnoreCase(headers, headerName) {
    const target = headerName.toLowerCase();
    for (const [key, value] of Object.entries(headers || {})) {
        if (key.toLowerCase() === target) {
            return value || '';
        }
    }
    return '';
}

function getResponseContentType() {
    return getHeaderValueIgnoreCase(latestResponseData?.headers || {}, 'content-type').toLowerCase();
}

function canPreviewCurrentBody() {
    if (!latestResponseData) return false;
    const contentType = getResponseContentType();
    if (currentBodyFormat === 'html') return true;
    if (contentType.startsWith('image/')) return !!getResponseBodyBase64();
    return false;
}

function hasJsonBody() {
    try {
        JSON.parse(latestResponseData?.body || '');
        return true;
    } catch {
        return false;
    }
}

function getBodyTextForCurrentFormat() {
    const raw = latestResponseData?.body || '';

    if (currentBodyFormat === 'json') {
        try {
            return JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
            return raw;
        }
    }
    if (currentBodyFormat === 'hex') {
        return formatHexFromBytes(getResponseBodyBytes());
    }
    if (currentBodyFormat === 'base64') {
        return getResponseBodyBase64() || formatBase64(raw);
    }

    return raw;
}

function getResponseBodyBase64() {
    const value = latestResponseData?.body_base64;
    return typeof value === 'string' && value.length > 0 ? value : '';
}

function getResponseBodyBytes() {
    const base64 = getResponseBodyBase64();
    if (base64) {
        try {
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return bytes;
        } catch {}
    }

    return new TextEncoder().encode(latestResponseData?.body || '');
}

function formatHexFromBytes(bytes) {
    const lines = [];
    for (let i = 0; i < bytes.length; i += 16) {
        const line = Array.from(bytes.subarray(i, i + 16))
            .map(byte => byte.toString(16).padStart(2, '0'))
            .join(' ');
        lines.push(line);
    }
    return lines.join('\n');
}

function formatBase64(text) {
    const bytes = new TextEncoder().encode(text || '');
    const chunkSize = 0x8000;
    let binary = '';

    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    return btoa(binary);
}

function isValidBase64(str) {
    try {
        atob(str);
        return true;
    } catch {
        return false;
    }
}

function highlightSearchText(text, query) {
    const source = text || '';
    const keyword = query || '';
    if (!keyword) return escapeHtml(source);

    const lowerSource = source.toLowerCase();
    const lowerKeyword = keyword.toLowerCase();
    const keywordLength = keyword.length;

    let html = '';
    let cursor = 0;
    let matchIndex = lowerSource.indexOf(lowerKeyword, cursor);

    while (matchIndex !== -1) {
        html += escapeHtml(source.slice(cursor, matchIndex));
        html += `<mark class="search-hit">${escapeHtml(source.slice(matchIndex, matchIndex + keywordLength))}</mark>`;
        cursor = matchIndex + keywordLength;
        matchIndex = lowerSource.indexOf(lowerKeyword, cursor);
    }

    html += escapeHtml(source.slice(cursor));
    return html;
}

function flattenJson(value, path, rows, depth) {
    if (rows.length >= 2000) return;
    if (depth > 30) {
        rows.push({ path, type: 'depth-limit', value: '[Max depth reached]' });
        return;
    }

    if (value === null) {
        rows.push({ path, type: 'null', value: 'null' });
        return;
    }

    if (Array.isArray(value)) {
        rows.push({ path, type: 'array', value: `(${value.length} items)` });
        value.forEach((item, index) => {
            flattenJson(item, `${path}[${index}]`, rows, depth + 1);
        });
        return;
    }

    if (typeof value === 'object') {
        rows.push({ path, type: 'object', value: `(${Object.keys(value).length} keys)` });
        Object.entries(value).forEach(([key, val]) => {
            flattenJson(val, `${path}.${key}`, rows, depth + 1);
        });
        return;
    }

    const primitiveType = typeof value;
    rows.push({ path, type: primitiveType, value: String(value) });
}

// ==================== 保存请求 ====================
window.saveRequest = async function() {
    syncCurrentRequestFromUI();
    openSaveRequestModal();
};

window.createNewFolder = function() {
    const name = prompt('Enter folder name:');
    if (name) {
        const newFolder = {
            id: Date.now().toString(),
            name: name,
            children: []
        };
        collections.push(newFolder);
        renderCollections();
        showToast('Folder created in memory. Add a request to persist it.');
    }
};

window.createNewRequest = function() {
    syncCurrentRequestFromUI();
    openSaveRequestModal();
};

window.openSaveRequestModal = function() {
    syncCurrentRequestFromUI();
    const active = getActiveTab();
    if (!active) return;

    const nameInput = document.getElementById('saveRequestNameInput');
    const folderSelect = document.getElementById('saveRequestFolderSelect');

    nameInput.value = getRequestDisplayName(active);
    folderSelect.innerHTML = '';

    if (collections.length === 0) {
        const opt = document.createElement('option');
        opt.value = 'default';
        opt.textContent = 'default / New Folder';
        folderSelect.appendChild(opt);
    } else {
        collections.forEach((folder) => {
            const opt = document.createElement('option');
            opt.value = folder.id;
            opt.textContent = `/${folder.name}`;
            folderSelect.appendChild(opt);
        });
    }

    document.getElementById('saveRequestModal').classList.add('active');
    nameInput.focus();
    nameInput.select();
};

window.closeSaveRequestModal = function() {
    document.getElementById('saveRequestModal').classList.remove('active');
};

window.confirmSaveRequest = async function() {
    const name = (document.getElementById('saveRequestNameInput').value || '').trim();
    const folderId = document.getElementById('saveRequestFolderSelect').value || 'default';

    if (!name) {
        showToast('Request name is required', 'error');
        return;
    }

    try {
        await persistRequestToCollection(name, folderId);
        closeSaveRequestModal();
        showToast('Request saved to Collections!');
    } catch (error) {
        console.error('Save request error:', error);
        showToast('Failed to save request', 'error');
    }
};

window.clearHistory = async function() {
    if (!confirm('Clear all history records?')) return;

    try {
        await invoke('clear_history');
        history = [];
        currentHistoryId = null;
        renderHistory();
        showToast('History cleared');
    } catch (error) {
        console.error('Clear history error:', error);
        showToast('Failed to clear history', 'error');
    }
};

window.openImportModal = function() {
    document.getElementById('importModal').classList.add('active');
    document.getElementById('importTextarea').focus();
};

window.closeImportModal = function() {
    document.getElementById('importModal').classList.remove('active');
};

window.importCurl = function() {
    const input = document.getElementById('importTextarea').value.trim();
    if (!input) {
        showToast('Please paste a cURL command', 'error');
        return;
    }

    const parsed = parseCurlCommand(input);
    if (!parsed.url) {
        showToast('Unable to parse URL from cURL command', 'error');
        return;
    }

    createNewRequestTab();
    document.getElementById('methodSelect').value = parsed.method || 'GET';
    document.getElementById('urlInput').value = parsed.url;
    document.getElementById('requestNameInput').value = parsed.url;
    parseUrlToParams();

    const headersBody = document.getElementById('headersBody');
    headersBody.innerHTML = '';
    parsed.headers.forEach(([key, value]) => addHeader(key, value, '', true));
    if (parsed.headers.length === 0) {
        addHeader();
    }

    document.getElementById('bodyEditor').value = parsed.body || '';
    switchRequestBodyType(parsed.body ? 'raw' : 'none');
    if (parsed.body) {
        const rawFormatSelect = document.getElementById('rawFormatSelect');
        if (rawFormatSelect) {
            rawFormatSelect.value = inferRawFormatByHeaders(parsed.headers);
        }
    }
    updateBadges();
    syncCurrentRequestFromUI();
    renderRequestTabs();
    closeImportModal();
    showToast('cURL imported');
};

window.exportCollection = function() {
    const data = JSON.stringify(collections, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'collection.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Collection exported!');
};

async function saveToHistory(request, response) {
    try {
        const id = await invoke('save_history', {
            method: request.method,
            url: request.url,
            requestData: JSON.stringify(request),
            responseData: JSON.stringify(response)
        });
        
        currentHistoryId = id;
        await loadHistory();
    } catch (error) {
        console.error('Save history error:', error);
    }
}

async function persistRequestToCollection(name, folderId = 'default') {
    syncCurrentRequestFromUI();
    const active = getActiveTab();
    if (!active) return;

    active.name = name;
    const queryParams = active.queryParams || collectQueryParams();
    const request = {
        id: active.id || Date.now().toString(),
        name,
        method: active.method || document.getElementById('methodSelect').value,
        url: buildUrlWithQuery(active.url || document.getElementById('urlInput').value, queryParams),
        request_data: JSON.stringify({
            name,
            method: active.method || document.getElementById('methodSelect').value,
            url: buildUrlWithQuery(active.url || document.getElementById('urlInput').value, queryParams),
            queryParams,
            headers: active.headers || collectHeaders(),
            body: active.body || document.getElementById('bodyEditor').value,
            bodyType: active.bodyType || getSelectedBodyType(),
            rawFormat: active.rawFormat || getSelectedRawFormat(),
            bodyFields: active.bodyFields || collectBodyFields(),
            binaryBody: active.binaryBody || document.getElementById('bodyBinaryEditor').value,
            graphqlQuery: active.graphqlQuery || document.getElementById('graphqlQueryEditor').value,
            graphqlVariables: active.graphqlVariables || document.getElementById('graphqlVariablesEditor').value
        })
    };

    await invoke('save_collection', { folderId, request });
    await loadCollections();
    renderRequestTabs();
}

// ==================== 可拖拽分割线 ====================
function initResizers() {
    // 垂直分割线（侧边栏）
    const sidebarResizer = document.getElementById('sidebarResizer');
    const sidebar = document.getElementById('sidebar');
    const iconSidebar = document.querySelector('.icon-sidebar');
    let isResizingSidebar = false;
    const minSidebarWidth = 220;
    const maxSidebarWidth = 420;
    const collapseThreshold = 120;
    
    sidebarResizer.addEventListener('mousedown', (e) => {
        isResizingSidebar = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isResizingSidebar) return;

        const baseLeft = iconSidebar.getBoundingClientRect().right;
        let newWidth = e.clientX - baseLeft;

        if (newWidth <= collapseThreshold) {
            sidebar.classList.add('collapsed');
            sidebar.style.width = '0px';
            return;
        }

        sidebar.classList.remove('collapsed');
        newWidth = Math.max(minSidebarWidth, Math.min(maxSidebarWidth, newWidth));
        sidebar.style.width = `${newWidth}px`;
    });
    
    document.addEventListener('mouseup', () => {
        isResizingSidebar = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });
    
    // 水平分割线（请求/响应面板）
    const panelResizer = document.getElementById('panelResizer');
    const requestBuilder = document.querySelector('.request-builder');
    const responsePanel = document.getElementById('responsePanel');
    let isResizingPanel = false;
    let panelStartY = 0;
    let requestStartHeight = 0;
    let responseStartHeight = 0;
    let minRequestHeight = 120;
    const minResponseHeight = 150;

    function getRequestBuilderMinHeight() {
        const urlBar = requestBuilder.querySelector('.url-bar-container');
        const tabs = requestBuilder.querySelector('.tabs');
        const fixedHeight = (urlBar?.offsetHeight || 0) + (tabs?.offsetHeight || 0);
        return Math.max(96, fixedHeight + 4);
    }
    
    panelResizer.addEventListener('mousedown', (e) => {
        isResizingPanel = true;
        panelStartY = e.clientY;
        requestStartHeight = requestBuilder.getBoundingClientRect().height;
        responseStartHeight = responsePanel.getBoundingClientRect().height;
        minRequestHeight = getRequestBuilderMinHeight();
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isResizingPanel) return;

        const deltaY = e.clientY - panelStartY;
        let newRequestHeight = requestStartHeight + deltaY;
        let newResponseHeight = responseStartHeight - deltaY;

        if (newRequestHeight < minRequestHeight) {
            const diff = minRequestHeight - newRequestHeight;
            newRequestHeight = minRequestHeight;
            newResponseHeight -= diff;
        }

        if (newResponseHeight < minResponseHeight) {
            const diff = minResponseHeight - newResponseHeight;
            newResponseHeight = minResponseHeight;
            newRequestHeight -= diff;
        }

        if (newRequestHeight < minRequestHeight || newResponseHeight < minResponseHeight) {
            return;
        }

        requestBuilder.style.flex = 'none';
        requestBuilder.style.height = `${newRequestHeight}px`;
        responsePanel.style.flex = 'none';
        responsePanel.style.height = `${newResponseHeight}px`;
    });
    
    document.addEventListener('mouseup', () => {
        isResizingPanel = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });
}

// ==================== 工具函数 ====================
function formatDateGroup(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    
    const diffDays = Math.floor((today - dateDay) / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return date.toLocaleDateString('en-US', { weekday: 'long' });
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function truncateUrl(url, maxLength = 35) {
    if (!url) return '';
    return url.length > maxLength ? url.substring(0, maxLength) + '...' : url;
}

function buildUrlWithQuery(rawUrl, queryParams) {
    const url = (rawUrl || '').trim();
    const questionMarkIndex = url.indexOf('?');
    const baseUrl = questionMarkIndex > -1 ? url.substring(0, questionMarkIndex) : url;

    const enabledParams = (queryParams || [])
        .filter(p => p.enabled && p.key)
        .map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value || '')}`);

    if (enabledParams.length === 0) {
        return baseUrl;
    }

    return `${baseUrl}?${enabledParams.join('&')}`;
}

function parseCurlCommand(input) {
    const normalized = input.replace(/\\\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    const methodMatch = normalized.match(/(?:^|\s)(?:-X|--request)\s+([A-Za-z]+)/);
    const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';

    const urlMatch = normalized.match(/(?:^|\s)(['"])(https?:\/\/[^'"]+)\1/) || normalized.match(/(?:^|\s)(https?:\/\/\S+)/);
    const url = urlMatch ? (urlMatch[2] || urlMatch[1] || '').trim() : '';

    const headers = [];
    const headerRegex = /(?:-H|--header)\s+(['"])(.*?)\1/g;
    let headerMatch = headerRegex.exec(normalized);
    while (headerMatch) {
        const line = headerMatch[2];
        const separatorIndex = line.indexOf(':');
        if (separatorIndex > 0) {
            const key = line.substring(0, separatorIndex).trim();
            const value = line.substring(separatorIndex + 1).trim();
            if (key) headers.push([key, value]);
        }
        headerMatch = headerRegex.exec(normalized);
    }

    const bodyMatch = normalized.match(/(?:--data-raw|--data-binary|--data|-d)\s+(['"])([\s\S]*?)\1/);
    const body = bodyMatch ? bodyMatch[2] : '';

    return { method, url, headers, body };
}

function inferRawFormatByHeaders(headers = []) {
    const contentTypeHeader = headers.find(([key]) => String(key).toLowerCase() === 'content-type');
    if (!contentTypeHeader) return 'json';

    const contentType = String(contentTypeHeader[1] || '').toLowerCase();
    if (contentType.includes('javascript') || contentType.includes('ecmascript')) return 'javascript';
    if (contentType.includes('json')) return 'json';
    if (contentType.includes('html')) return 'html';
    if (contentType.includes('xml')) return 'xml';
    if (contentType.includes('text/plain')) return 'text';
    return 'json';
}

window.showToast = function(message, type = 'success') {
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.style.position = 'fixed';
        container.style.top = '20px';
        container.style.right = '20px';
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.gap = '8px';
        container.style.zIndex = '20000';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.padding = '10px 14px';
    toast.style.borderRadius = '6px';
    toast.style.fontSize = '12px';
    toast.style.color = '#fff';
    toast.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.18)';
    toast.style.background = type === 'error' ? '#f93e3e' : '#49cc90';
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.2s';

    container.appendChild(toast);
    requestAnimationFrame(() => {
        toast.style.opacity = '1';
    });

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 200);
    }, 2200);
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(2) + ' MB';
}

function syntaxHighlight(json) {
    let str = JSON.stringify(json, null, 2);
    str = str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return str.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
        let cls = 'json-number';
        if (/^"/.test(match)) {
            if (/:$/.test(match)) {
                cls = 'json-key';
            } else {
                cls = 'json-string';
            }
        } else if (/true|false/.test(match)) {
            cls = 'json-boolean';
        } else if (/null/.test(match)) {
            cls = 'json-null';
        }
        return '<span class="' + cls + '">' + match + '</span>';
    });
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
