import { invoke } from '@tauri-apps/api/core';

// ==================== 全局状态 ====================
let currentRequest = {
    id: null,
    method: 'GET',
    url: '',
    queryParams: [],
    headers: [],
    body: ''
};

let collections = [];
let history = [];
let currentHistoryId = null;
let isUpdatingUrl = false;
let isUpdatingParams = false;

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', async () => {
    await loadHistory();
    await loadCollections();
    initResizers();
    initUrlSync();
    
    // 添加默认参数行
    addQueryParam();
    addHeader();
    updateBadges();
});

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
    
    updateBadges();
    
    setTimeout(() => {
        isUpdatingUrl = false;
    }, 0);
}

// ==================== 侧边栏切换 ====================
window.switchSidebar = function(tab) {
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
    
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
    
    if (request) {
        document.getElementById('methodSelect').value = request.method;
        document.getElementById('urlInput').value = request.url;
        parseUrlToParams();
    }
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
        
        const requestData = JSON.parse(item.request_data);
        currentRequest = requestData;
        
        // 更新 UI
        document.getElementById('methodSelect').value = requestData.method;
        document.getElementById('urlInput').value = requestData.url;
        document.getElementById('bodyEditor').value = requestData.body || '';
        
        // 清空并重新加载参数
        document.getElementById('queryParamsBody').innerHTML = '';
        document.getElementById('headersBody').innerHTML = '';
        
        requestData.queryParams.forEach(param => {
            addQueryParam(param.key, param.value, param.description || '', param.enabled);
        });
        
        requestData.headers.forEach(header => {
            addHeader(header.key, header.value, header.description || '', header.enabled);
        });
        
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
window.switchTab = function(tab) {
    document.querySelectorAll('.tabs .tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
    
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    document.getElementById(tab + 'Panel').classList.remove('hidden');
};

window.switchResponseTab = function(tab) {
    document.querySelectorAll('.response-tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
    
    document.getElementById('responseBody').classList.add('hidden');
    document.getElementById('responseHeaders').classList.add('hidden');
    document.getElementById('responseCookies').classList.add('hidden');
    
    document.getElementById('response' + tab.charAt(0).toUpperCase() + tab.slice(1)).classList.remove('hidden');
};

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
        currentRequest.url = document.getElementById('urlInput').value;
        currentRequest.queryParams = collectQueryParams();
        currentRequest.headers = collectHeaders();
        currentRequest.body = document.getElementById('bodyEditor').value;
        
        if (!currentRequest.url) {
            alert('Please enter a URL');
            return;
        }
        
        // 构建请求头
        const headers = {};
        currentRequest.headers
            .filter(h => h.enabled)
            .forEach(h => headers[h.key] = h.value);
        
        // 如果有 body，自动添加 Content-Type
        if (currentRequest.body && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }
        
        // 发送请求
        const requestData = {
            method: currentRequest.method,
            url: currentRequest.url,
            headers: Object.entries(headers),
            body: currentRequest.body || null
        };
        
        const responseData = await invoke('send_http_request', { request: requestData });
        
        // 显示响应
        displayResponse(responseData);
        
        // 保存到历史
        await saveToHistory(currentRequest, responseData);
        
    } catch (error) {
        console.error('Request error:', error);
        document.getElementById('responseBody').innerHTML = `
            <div style="color: #f93e3e; padding: 20px;">
                <strong>Error:</strong><br/>
                ${escapeHtml(error.message || error)}
            </div>
        `;
    } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
    }
};

// ==================== 显示响应 ====================
function displayResponse(data) {
    // 状态码
    const statusCode = document.getElementById('statusCode');
    statusCode.textContent = `${data.status} ${data.status_text}`;
    statusCode.className = 'status-code ' + 
        (data.status < 300 ? 'status-success' : 
         data.status < 500 ? 'status-warning' : 'status-error');
    
    // 时间和大小
    document.getElementById('responseTime').textContent = `${data.duration} ms`;
    document.getElementById('responseSize').textContent = formatSize(data.size);
    
    // 响应体
    const responseBody = document.getElementById('responseBody');
    try {
        const json = JSON.parse(data.body);
        responseBody.innerHTML = `<pre>${syntaxHighlight(json)}</pre>`;
    } catch {
        responseBody.innerHTML = `<pre>${escapeHtml(data.body)}</pre>`;
    }
    
    // 响应头
    const responseHeaders = document.getElementById('responseHeaders');
    let headersHtml = '<table class="params-table"><tbody>';
    for (const [key, value] of Object.entries(data.headers)) {
        headersHtml += `
            <tr>
                <td style="color: #d73a49; font-weight: 500;">${escapeHtml(key)}</td>
                <td>${escapeHtml(value)}</td>
            </tr>
        `;
    }
    headersHtml += '</tbody></table>';
    responseHeaders.innerHTML = headersHtml;
    
    // Cookies
    document.getElementById('responseCookies').innerHTML = `
        <div class="empty-state">
            <div class="empty-state-icon">🍪</div>
            <div>No cookies received</div>
        </div>
    `;
}

// ==================== 保存请求 ====================
window.saveRequest = async function() {
    // TODO: 实现保存到 Collections
    alert('Save to Collections - Coming soon!');
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
        showToast('Folder created!');
    }
};

window.createNewRequest = function() {
    const name = prompt('Enter request name:');
    if (name) {
        // 创建新请求到第一个文件夹，或创建新文件夹
        if (collections.length === 0) {
            createNewFolder();
            return;
        }
        
        const newRequest = {
            id: Date.now().toString(),
            name: name,
            method: document.getElementById('methodSelect').value,
            url: document.getElementById('urlInput').value,
            request_data: JSON.stringify({
                method: document.getElementById('methodSelect').value,
                url: document.getElementById('urlInput').value,
                queryParams: collectQueryParams(),
                headers: collectHeaders(),
                body: document.getElementById('bodyEditor').value
            })
        };
        
        collections[0].children.push(newRequest);
        renderCollections();
        showToast('Request saved to Collections!');
    }
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

// ==================== 可拖拽分割线 ====================
function initResizers() {
    // 垂直分割线（侧边栏）
    const sidebarResizer = document.getElementById('sidebarResizer');
    const sidebar = document.getElementById('sidebar');
    let isResizingSidebar = false;
    
    sidebarResizer.addEventListener('mousedown', (e) => {
        isResizingSidebar = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isResizingSidebar) return;
        
        const newWidth = e.clientX;
        if (newWidth >= 200 && newWidth <= 400) {
            sidebar.style.width = newWidth + 'px';
        }
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
    
    panelResizer.addEventListener('mousedown', (e) => {
        isResizingPanel = true;
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isResizingPanel) return;
        
        const containerHeight = document.querySelector('.main').clientHeight;
        const newRequestHeight = e.clientY - document.querySelector('.main').offsetTop;
        const responseHeight = containerHeight - newRequestHeight - 4; // 4px for resizer
        
        if (newRequestHeight >= 300 && responseHeight >= 150) {
            requestBuilder.style.flex = 'none';
            requestBuilder.style.height = newRequestHeight + 'px';
            responsePanel.style.flex = 'none';
            responsePanel.style.height = responseHeight + 'px';
        }
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
