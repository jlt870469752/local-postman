import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as dialogOpen, save as dialogSave } from '@tauri-apps/plugin-dialog';

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
let historySearchQuery = '';
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
let isMethodPickerOpen = false;
let isBodyFormatPickerOpen = false;
let collectionsSearchQuery = '';
let collapsedCollectionFolderIds = new Set();
let activeCollectionMenuState = null;
let draggingCollectionRequestState = null;
let draggingCollectionRequestClearTimer = null;
let isSendingRequest = false;
let activeSendOperationId = null;
let canceledSendOperationIds = new Set();
let selectedImportCollectionFile = null;
let activeTextPromptResolver = null;
let activeConfirmResolver = null;
const ENABLE_COLLECTION_DRAG_LOG = true;
const COLLECTION_DRAG_PATCH_VERSION = 'drag-ptr-v2';
const COLLECTION_DRAG_START_THRESHOLD = 12;
let pendingCollectionPointerDrag = null;
let activeCollectionPointerDrag = null;
let pointerDragHoverInfo = null;
let collectionPointerDragSuppressClickUntil = 0;
let activeRightSidebarTab = 'curl';
let activeFeature = 'home';
let lamaServiceActionInProgress = false;
let lamaLastKnownPort = 8088;
let lamaLastKnownExecutablePath = 'lama-cleaner';
let lamaLastKnownDevice = 'cpu';
let lamaLastKnownPythonPath = 'python3';
let lamaLastKnownModelPath = '~/.cache/torch/hub/checkpoints/big-lama.pt';
let lamaLastKnownModelDownloaded = false;
let lamaLastKnownModelSizeBytes = 0;
const SAM_BRIDGE_MESSAGE_FLAG = '__SAM_TAURI_BRIDGE_MESSAGE__';
const samBridgeEventListeners = new Map();

// Expose a stable bridge for iframe-based SAM UI.
window.__SAM_TAURI_BRIDGE__ = {
    core: { invoke, convertFileSrc },
    event: { listen },
    dialog: {
        open: dialogOpen,
        save: dialogSave
    }
};

function getSamFeatureFrameWindow() {
    const frame = document.getElementById('samFeatureFrame');
    return frame?.contentWindow || null;
}

function getSamDialogBridge() {
    return window.__SAM_TAURI_BRIDGE__?.dialog || null;
}

function postSamBridgeMessage(targetWindow, message) {
    if (!targetWindow || typeof targetWindow.postMessage !== 'function') return;
    targetWindow.postMessage({
        [SAM_BRIDGE_MESSAGE_FLAG]: true,
        ...message
    }, '*');
}

async function cleanupSamBridgeListener(listenerId) {
    const unlisten = samBridgeEventListeners.get(listenerId);
    if (!unlisten) return;
    samBridgeEventListeners.delete(listenerId);
    try {
        await unlisten();
    } catch (error) {
        console.warn('[sam-bridge] failed to cleanup listener', error);
    }
}

async function handleSamBridgeMessage(event) {
    const data = event?.data;
    if (!data || data[SAM_BRIDGE_MESSAGE_FLAG] !== true || data.direction !== 'request') {
        return;
    }

    const sourceWindow = event.source;
    if (!sourceWindow || typeof sourceWindow.postMessage !== 'function') {
        return;
    }

    const frameWindow = getSamFeatureFrameWindow();
    if (frameWindow && sourceWindow !== frameWindow) {
        return;
    }

    const requestId = typeof data.requestId === 'string' ? data.requestId : '';
    const action = typeof data.action === 'string' ? data.action : '';
    if (!requestId || !action) {
        return;
    }

    try {
        let result = null;
        const payload = data.payload || {};

        if (action === 'ping') {
            const dialog = getSamDialogBridge();
            result = {
                ready: true,
                hasDialog: !!dialog,
                hasEvent: true
            };
        } else if (action === 'invoke') {
            if (!payload.cmd || typeof payload.cmd !== 'string') {
                throw new Error('Missing invoke command');
            }
            result = await invoke(payload.cmd, payload.args || {});
        } else if (action === 'convert-file-src') {
            const filePath = typeof payload.path === 'string' ? payload.path.trim() : '';
            if (!filePath) {
                throw new Error('Missing file path');
            }
            result = convertFileSrc(filePath);
        } else if (action === 'dialog-open') {
            const dialog = getSamDialogBridge();
            if (!dialog || typeof dialog.open !== 'function') {
                throw new Error('Tauri dialog not available');
            }
            result = await dialog.open(payload.options || {});
        } else if (action === 'dialog-save') {
            const dialog = getSamDialogBridge();
            if (!dialog || typeof dialog.save !== 'function') {
                throw new Error('Tauri dialog not available');
            }
            result = await dialog.save(payload.options || {});
        } else if (action === 'listen') {
            const eventName = payload.eventName || payload.event;
            if (!eventName || typeof eventName !== 'string') {
                throw new Error('Missing event name');
            }

            const listenerId = `sam-listener-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const unlisten = await listen(eventName, (tauriEvent) => {
                postSamBridgeMessage(sourceWindow, {
                    direction: 'event',
                    listenerId,
                    eventName,
                    payload: tauriEvent?.payload ?? null
                });
            });
            samBridgeEventListeners.set(listenerId, unlisten);
            result = { listenerId };
        } else if (action === 'unlisten') {
            const listenerId = typeof payload.listenerId === 'string' ? payload.listenerId : '';
            if (!listenerId) {
                throw new Error('Missing listenerId');
            }
            await cleanupSamBridgeListener(listenerId);
            result = { removed: true };
        } else {
            throw new Error(`Unsupported bridge action: ${action}`);
        }

        postSamBridgeMessage(sourceWindow, {
            direction: 'response',
            requestId,
            ok: true,
            result
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        postSamBridgeMessage(sourceWindow, {
            direction: 'response',
            requestId,
            ok: false,
            error: message
        });
    }
}

window.addEventListener('message', (event) => {
    void handleSamBridgeMessage(event);
});

window.addEventListener('beforeunload', () => {
    const listenerIds = Array.from(samBridgeEventListeners.keys());
    listenerIds.forEach((listenerId) => {
        void cleanupSamBridgeListener(listenerId);
    });
});

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
            if (activeCollectionMenuState) {
                hideCollectionItemMenu();
                return;
            }
            if (isBodyFormatPickerOpen) {
                hideBodyFormatPicker();
                return;
            }
            if (isMethodPickerOpen) {
                hideMethodPicker();
                return;
            }
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

    document.addEventListener('click', (e) => {
        if (!isMethodPickerOpen) return;
        const picker = document.getElementById('methodPicker');
        if (picker && !picker.contains(e.target)) {
            hideMethodPicker();
        }
    });

    document.addEventListener('click', (e) => {
        if (!isBodyFormatPickerOpen) return;
        const picker = document.getElementById('bodyFormatPicker');
        if (picker && !picker.contains(e.target)) {
            hideBodyFormatPicker();
        }
    });

    document.addEventListener('click', (e) => {
        if (!activeCollectionMenuState) return;
        const menu = document.getElementById('collectionItemMenu');
        const target = e.target;
        if (menu && menu.contains(target)) return;
        if (target && target.closest('.tree-item-action-btn')) return;
        hideCollectionItemMenu();
    });

    window.addEventListener('resize', () => {
        updateRequestTabsOverflowControls();
        if (isBodyFormatPickerOpen) {
            updateBodyFormatMenuPlacement();
        }
        syncWorkspaceTopbarState();
        syncRightSidebarState();
        if (activeCollectionMenuState) {
            hideCollectionItemMenu();
        }
    });

    if (window.PointerEvent) {
        document.addEventListener('pointermove', (evt) => {
            window.handleCollectionPointerMove(evt);
        });
        document.addEventListener('pointerup', (evt) => {
            void window.handleCollectionPointerUp(evt);
        });
        document.addEventListener('pointercancel', (evt) => {
            void window.handleCollectionPointerUp(evt, true);
        });
    } else {
        document.addEventListener('mousemove', (evt) => {
            window.handleCollectionPointerMove(evt);
        });
        document.addEventListener('mouseup', (evt) => {
            void window.handleCollectionPointerUp(evt);
        });
    }
    window.addEventListener('blur', () => {
        void window.handleCollectionPointerUp(null, true);
    });

    syncMethodPickerDisplay();
    switchResponseView('body');
    switchBodyFormat('json');
    syncBodyFormatPickerDisplay();
    syncWorkspaceTopbarState();
    updateSendButtonState();
    syncRightSidebarState();
    renderCurrentRequestCurl();
    setFeatureView('home');
    if (ENABLE_COLLECTION_DRAG_LOG) {
        showToast(`Drag patch loaded: ${COLLECTION_DRAG_PATCH_VERSION}`);
    }
});

function getEventTarget(evt) {
    return evt?.currentTarget || evt?.target || window.event?.currentTarget || window.event?.target || null;
}

function logCollectionDrag(step, data = {}) {
    if (!ENABLE_COLLECTION_DRAG_LOG) return;
    console.error('[collections-drag]', step, data);
}

function ensureTextPromptModal() {
    let overlay = document.getElementById('textPromptModal');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'textPromptModal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal" style="width: 420px; max-width: 88vw;">
            <div class="modal-header">
                <div class="modal-title" id="textPromptTitle">Rename</div>
                <button class="modal-close" type="button" id="textPromptCloseBtn">×</button>
            </div>
            <div class="modal-body">
                <input id="textPromptInput" class="modal-input" type="text" autocomplete="off" />
            </div>
            <div class="modal-footer">
                <button class="modal-btn secondary" type="button" id="textPromptCancelBtn">Cancel</button>
                <button class="modal-btn primary" type="button" id="textPromptConfirmBtn">Confirm</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const resolvePrompt = (value) => {
        if (!activeTextPromptResolver) return;
        const resolver = activeTextPromptResolver;
        activeTextPromptResolver = null;
        overlay.classList.remove('active');
        resolver(value);
    };

    const input = overlay.querySelector('#textPromptInput');
    const closeBtn = overlay.querySelector('#textPromptCloseBtn');
    const cancelBtn = overlay.querySelector('#textPromptCancelBtn');
    const confirmBtn = overlay.querySelector('#textPromptConfirmBtn');

    overlay.addEventListener('click', (evt) => {
        if (evt.target === overlay) {
            resolvePrompt(null);
        }
    });
    closeBtn?.addEventListener('click', () => resolvePrompt(null));
    cancelBtn?.addEventListener('click', () => resolvePrompt(null));
    confirmBtn?.addEventListener('click', () => resolvePrompt(input?.value ?? ''));
    input?.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter') {
            evt.preventDefault();
            resolvePrompt(input?.value ?? '');
            return;
        }
        if (evt.key === 'Escape') {
            evt.preventDefault();
            resolvePrompt(null);
        }
    });

    return overlay;
}

async function openTextPromptModal(title, initialValue = '') {
    const overlay = ensureTextPromptModal();
    const titleEl = overlay.querySelector('#textPromptTitle');
    const input = overlay.querySelector('#textPromptInput');

    if (titleEl) {
        titleEl.textContent = title || 'Rename';
    }

    if (input) {
        input.value = initialValue || '';
    }

    overlay.classList.add('active');
    requestAnimationFrame(() => {
        if (!input) return;
        input.focus();
        input.select();
    });

    return await new Promise((resolve) => {
        if (activeTextPromptResolver) {
            activeTextPromptResolver(null);
        }
        activeTextPromptResolver = resolve;
    });
}

function ensureConfirmModal() {
    let overlay = document.getElementById('confirmModal');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'confirmModal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal" style="width: 440px; max-width: 90vw;">
            <div class="modal-header">
                <div class="modal-title" id="confirmModalTitle">Confirm</div>
                <button class="modal-close" type="button" id="confirmModalCloseBtn">×</button>
            </div>
            <div class="modal-body">
                <div id="confirmModalMessage" style="font-size: 13px; color: #333; line-height: 1.6;"></div>
            </div>
            <div class="modal-footer">
                <button class="modal-btn secondary" type="button" id="confirmModalCancelBtn">Cancel</button>
                <button class="modal-btn primary" type="button" id="confirmModalConfirmBtn">Delete</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const resolveConfirm = (result) => {
        if (!activeConfirmResolver) return;
        const resolver = activeConfirmResolver;
        activeConfirmResolver = null;
        overlay.classList.remove('active');
        resolver(!!result);
    };

    const closeBtn = overlay.querySelector('#confirmModalCloseBtn');
    const cancelBtn = overlay.querySelector('#confirmModalCancelBtn');
    const confirmBtn = overlay.querySelector('#confirmModalConfirmBtn');

    overlay.addEventListener('click', (evt) => {
        if (evt.target === overlay) {
            resolveConfirm(false);
        }
    });
    closeBtn?.addEventListener('click', () => resolveConfirm(false));
    cancelBtn?.addEventListener('click', () => resolveConfirm(false));
    confirmBtn?.addEventListener('click', () => resolveConfirm(true));
    overlay.addEventListener('keydown', (evt) => {
        if (!activeConfirmResolver) return;
        if (evt.key === 'Escape') {
            evt.preventDefault();
            resolveConfirm(false);
            return;
        }
        if (evt.key === 'Enter') {
            evt.preventDefault();
            resolveConfirm(true);
        }
    });

    return overlay;
}

async function openConfirmModal(message, title = 'Confirm') {
    const overlay = ensureConfirmModal();
    const titleEl = overlay.querySelector('#confirmModalTitle');
    const messageEl = overlay.querySelector('#confirmModalMessage');

    if (titleEl) {
        titleEl.textContent = title || 'Confirm';
    }
    if (messageEl) {
        messageEl.textContent = message || '';
    }

    overlay.classList.add('active');
    overlay.tabIndex = -1;
    requestAnimationFrame(() => {
        overlay.focus();
    });

    return await new Promise((resolve) => {
        if (activeConfirmResolver) {
            activeConfirmResolver(false);
        }
        activeConfirmResolver = resolve;
    });
}

function syncWorkspaceTopbarState() {
    const leftShell = document.querySelector('.left-shell');
    const sidebar = document.getElementById('sidebar');
    if (!leftShell || !sidebar) return;

    const inlineWidth = (sidebar.style.width || '').trim();
    const isCollapsed = sidebar.classList.contains('collapsed') || inlineWidth === '0px' || inlineWidth === '0';
    leftShell.classList.toggle('sidebar-collapsed', isCollapsed);
}

function updateSendButtonState() {
    const sendBtn = document.getElementById('sendBtn');
    if (!sendBtn) return;

    const hasActiveTab = !!getActiveTab();
    sendBtn.classList.toggle('is-sending', isSendingRequest);
    sendBtn.textContent = isSendingRequest ? 'Cancel' : 'Send';
    sendBtn.disabled = !hasActiveTab;
}

function startSendOperation() {
    const operationId = `send-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    activeSendOperationId = operationId;
    isSendingRequest = true;
    updateSendButtonState();
    return operationId;
}

function finishSendOperation(operationId) {
    canceledSendOperationIds.delete(operationId);
    if (activeSendOperationId === operationId) {
        activeSendOperationId = null;
        isSendingRequest = false;
        updateSendButtonState();
    }
}

function isSendOperationCanceled(operationId) {
    return canceledSendOperationIds.has(operationId) || activeSendOperationId !== operationId;
}

window.cancelSendRequest = function(showToastMessage = true) {
    if (!isSendingRequest || !activeSendOperationId) return false;
    canceledSendOperationIds.add(activeSendOperationId);
    activeSendOperationId = null;
    isSendingRequest = false;
    updateSendButtonState();
    if (showToastMessage) {
        showToast('Request canceled');
    }
    return true;
};

function getUiIconSvg(name) {
    const icons = {
        'chevron-down': `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 9l6 6 6-6"></path>
            </svg>
        `,
        folder: `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3.5 7h6l1.8 2H20.5v10.5H3.5z"></path>
            </svg>
        `,
        clock: `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="8"></circle>
                <path d="M12 8v5l3 2"></path>
            </svg>
        `,
        signal: `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="13" r="2"></circle>
                <path d="M12 3v6"></path>
                <path d="M8 9a6 6 0 0 0 0 8"></path>
                <path d="M16 9a6 6 0 0 1 0 8"></path>
            </svg>
        `,
        warning: `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 4.5l8 14H4z"></path>
                <path d="M12 10v4"></path>
                <path d="M12 17h0"></path>
            </svg>
        `,
        search: `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="6"></circle>
                <path d="M16 16l4 4"></path>
            </svg>
        `,
        'more-horizontal': `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="6.5" cy="12" r="1.3"></circle>
                <circle cx="12" cy="12" r="1.3"></circle>
                <circle cx="17.5" cy="12" r="1.3"></circle>
            </svg>
        `,
        inbox: `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 6.5h16v11H4z"></path>
                <path d="M4 14h4l2 2h4l2-2h4"></path>
            </svg>
        `,
        cookie: `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M16 5.5a2 2 0 1 0 3 2.6A7.5 7.5 0 1 1 9 5.2a2 2 0 0 0 2.7-2.7A7.4 7.4 0 0 1 16 5.5z"></path>
                <path d="M9 10h0"></path>
                <path d="M14 13h0"></path>
                <path d="M10.5 15.5h0"></path>
            </svg>
        `
    };

    return icons[name] || '';
}

const METHOD_COLOR_CLASS_MAP = {
    GET: 'method-color-GET',
    POST: 'method-color-POST',
    PUT: 'method-color-PUT',
    PATCH: 'method-color-PATCH',
    DELETE: 'method-color-DELETE',
    HEAD: 'method-color-HEAD',
    OPTIONS: 'method-color-OPTIONS'
};

function normalizeMethodValue(method) {
    const normalized = String(method || 'GET').trim().toUpperCase();
    return normalized || 'GET';
}

function ensureMethodOption(select, method) {
    if (!select) return;
    const exists = Array.from(select.options).some((option) => option.value === method);
    if (exists) return;

    const option = document.createElement('option');
    option.value = method;
    option.textContent = method;
    select.appendChild(option);
}

function setMethodSelectValue(method) {
    const methodSelect = document.getElementById('methodSelect');
    if (!methodSelect) return;
    const normalized = normalizeMethodValue(method);
    ensureMethodOption(methodSelect, normalized);
    methodSelect.value = normalized;
}

function getMethodColorClass(method) {
    return METHOD_COLOR_CLASS_MAP[normalizeMethodValue(method)] || METHOD_COLOR_CLASS_MAP.GET;
}

function applyMethodColorClass(element, method) {
    if (!element) return;
    Object.values(METHOD_COLOR_CLASS_MAP).forEach((className) => element.classList.remove(className));
    element.classList.add(getMethodColorClass(method));
}

function updateMethodPickerVisibility() {
    const picker = document.getElementById('methodPicker');
    const menu = document.getElementById('methodPickerMenu');
    if (!picker || !menu) return;

    picker.classList.toggle('open', isMethodPickerOpen);
    menu.classList.toggle('hidden', !isMethodPickerOpen);
}

function hideMethodPicker() {
    if (!isMethodPickerOpen) return;
    isMethodPickerOpen = false;
    updateMethodPickerVisibility();
}

function syncMethodPickerDisplay() {
    const methodSelect = document.getElementById('methodSelect');
    const pickerValue = document.getElementById('methodPickerValue');
    const pickerItems = document.querySelectorAll('.method-picker-item[data-method]');
    if (!methodSelect || !pickerValue) return;

    const normalized = normalizeMethodValue(methodSelect.value || 'GET');
    ensureMethodOption(methodSelect, normalized);
    methodSelect.value = normalized;

    pickerValue.textContent = normalized;
    applyMethodColorClass(pickerValue, normalized);
    pickerItems.forEach((item) => {
        const itemMethod = normalizeMethodValue(item.dataset.method || '');
        item.classList.toggle('active', itemMethod === normalized);
    });
}

window.toggleMethodPicker = function(evt) {
    if (evt) {
        evt.preventDefault();
        evt.stopPropagation();
    }

    isMethodPickerOpen = !isMethodPickerOpen;
    updateMethodPickerVisibility();
};

window.selectMethod = function(method) {
    const methodSelect = document.getElementById('methodSelect');
    if (!methodSelect) return;

    const normalized = normalizeMethodValue(method);
    ensureMethodOption(methodSelect, normalized);
    methodSelect.value = normalized;
    syncMethodPickerDisplay();
    methodSelect.dispatchEvent(new Event('change', { bubbles: true }));
    hideMethodPicker();
};

const BODY_FORMAT_META = {
    json: { label: 'JSON', icon: '{}' },
    xml: { label: 'XML', icon: '</>' },
    html: { label: 'HTML', icon: '</>' },
    javascript: { label: 'JavaScript', icon: 'JS' },
    raw: { label: 'Raw', icon: 'T=' },
    hex: { label: 'Hex', icon: '0x' },
    base64: { label: 'Base64', icon: '64' }
};

function normalizeBodyFormatValue(format) {
    const normalized = String(format || 'json').trim().toLowerCase();
    return BODY_FORMAT_META[normalized] ? normalized : 'json';
}

function updateBodyFormatPickerVisibility() {
    const picker = document.getElementById('bodyFormatPicker');
    const menu = document.getElementById('bodyFormatMenu');
    if (!picker || !menu) return;

    picker.classList.toggle('open', isBodyFormatPickerOpen);
    menu.classList.toggle('hidden', !isBodyFormatPickerOpen);
    if (!isBodyFormatPickerOpen) {
        picker.classList.remove('open-up');
        return;
    }

    requestAnimationFrame(() => {
        updateBodyFormatMenuPlacement();
    });
}

function updateBodyFormatMenuPlacement() {
    const picker = document.getElementById('bodyFormatPicker');
    const menu = document.getElementById('bodyFormatMenu');
    if (!picker || !menu || menu.classList.contains('hidden')) return;

    picker.classList.remove('open-up');

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const pickerRect = picker.getBoundingClientRect();
    const menuHeight = menu.offsetHeight;
    const safetyGap = 8;
    const spaceBelow = viewportHeight - pickerRect.bottom - safetyGap;
    const spaceAbove = pickerRect.top - safetyGap;
    const shouldOpenUp = spaceBelow < menuHeight && spaceAbove > spaceBelow;

    picker.classList.toggle('open-up', shouldOpenUp);
}

function hideBodyFormatPicker() {
    if (!isBodyFormatPickerOpen) return;
    isBodyFormatPickerOpen = false;
    updateBodyFormatPickerVisibility();
}

function syncBodyFormatPickerDisplay() {
    const select = document.getElementById('bodyFormatSelect');
    const labelEl = document.getElementById('bodyFormatPickerLabel');
    const iconEl = document.getElementById('bodyFormatPickerIcon');
    const items = document.querySelectorAll('.response-format-item[data-format]');
    if (!select || !labelEl || !iconEl) return;

    const format = normalizeBodyFormatValue(select.value);
    select.value = format;
    const meta = BODY_FORMAT_META[format];

    labelEl.textContent = meta.label;
    iconEl.textContent = meta.icon;

    items.forEach((item) => {
        const itemFormat = normalizeBodyFormatValue(item.dataset.format || '');
        item.classList.toggle('active', itemFormat === format);
    });
}

window.toggleBodyFormatPicker = function(evt) {
    if (evt) {
        evt.preventDefault();
        evt.stopPropagation();
    }

    isBodyFormatPickerOpen = !isBodyFormatPickerOpen;
    updateBodyFormatPickerVisibility();
};

window.selectBodyFormat = function(format) {
    const normalized = normalizeBodyFormatValue(format);
    switchBodyFormat(normalized);
    hideBodyFormatPicker();
};

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
        ensureTabResponseState(existing);
        existing.sourceType = sourceType;
        existing.sourceId = normalizedSourceId;
        activateTabById(existing.id);
        return { reused: true, tab: existing };
    }

    syncCurrentRequestFromUI();
    const newTab = createNewTabState();
    ensureTabResponseState(newTab);
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
    const tab = normalizeRequest({
        id: Date.now().toString(),
        method: document.getElementById('methodSelect')?.value || 'GET'
    });
    tab.responseData = null;
    tab.responseBodyFormat = 'json';
    tab.responseError = false;
    return tab;
}

function cloneResponseData(data) {
    if (!data || typeof data !== 'object') return null;
    try {
        return JSON.parse(JSON.stringify(data));
    } catch {
        return null;
    }
}

function ensureTabResponseState(tab) {
    if (!tab || typeof tab !== 'object') return;
    if (!Object.prototype.hasOwnProperty.call(tab, 'responseData')) {
        tab.responseData = null;
    }
    if (!Object.prototype.hasOwnProperty.call(tab, 'responseBodyFormat')) {
        tab.responseBodyFormat = 'json';
    }
    if (!Object.prototype.hasOwnProperty.call(tab, 'responseError')) {
        tab.responseError = false;
    }
}

function setTabResponseState(tab, responseData, options = {}) {
    if (!tab) return;
    ensureTabResponseState(tab);
    const normalizedData = cloneResponseData(responseData);
    tab.responseData = normalizedData;
    tab.responseBodyFormat = normalizeBodyFormatValue(
        options.bodyFormat || tab.responseBodyFormat || 'json'
    );
    tab.responseError = !!options.isError;
}

function clearTabResponseState(tab) {
    if (!tab) return;
    ensureTabResponseState(tab);
    tab.responseData = null;
    tab.responseBodyFormat = 'json';
    tab.responseError = false;
}

function applyResponseStatusMeta(data, isError = false) {
    const statusCodeEl = document.getElementById('statusCode');
    const timeEl = document.getElementById('responseTime');
    const sizeEl = document.getElementById('responseSize');

    if (!data) {
        statusCodeEl.textContent = '--';
        statusCodeEl.className = 'status-code';
        timeEl.textContent = '-- ms';
        sizeEl.textContent = '-- B';
        return;
    }

    if (isError) {
        statusCodeEl.textContent = 'Error';
        statusCodeEl.className = 'status-code status-error';
        timeEl.textContent = '-- ms';
        sizeEl.textContent = '-- B';
        return;
    }

    const status = Number(data.status);
    const duration = Number(data.duration);
    const size = Number(data.size);
    if (Number.isFinite(status)) {
        statusCodeEl.textContent = `${status} ${data.status_text || ''}`.trim();
        statusCodeEl.className = 'status-code ' +
            (status < 300 ? 'status-success' :
             status < 500 ? 'status-warning' : 'status-error');
    } else {
        statusCodeEl.textContent = 'Response';
        statusCodeEl.className = 'status-code';
    }
    timeEl.textContent = Number.isFinite(duration) ? `${duration} ms` : '-- ms';
    sizeEl.textContent = Number.isFinite(size) ? formatSize(size) : '-- B';
}

function applyActiveTabResponseToUI() {
    const tab = getActiveTab();
    if (!tab) {
        latestResponseData = null;
        currentBodyFormat = 'json';
        isBodyPreview = false;
        isBodyVisualize = false;
        const bodyFormatSelect = document.getElementById('bodyFormatSelect');
        if (bodyFormatSelect) {
            bodyFormatSelect.value = 'json';
        }
        syncBodyFormatPickerDisplay();
        applyResponseStatusMeta(null, false);
        renderResponseHeaders({});
        renderResponseCookies({});
        updatePreviewButtonState();
        updateVisualizeButtonState();
        updateResponsePanels();
        if (currentResponseView === 'body') {
            renderResponseBody();
        }
        return;
    }
    ensureTabResponseState(tab);

    latestResponseData = tab.responseData ? cloneResponseData(tab.responseData) : null;
    currentBodyFormat = normalizeBodyFormatValue(
        tab.responseBodyFormat || (latestResponseData ? inferResponseBodyFormat(latestResponseData) : 'json')
    );
    isBodyPreview = false;
    isBodyVisualize = false;

    const bodyFormatSelect = document.getElementById('bodyFormatSelect');
    if (bodyFormatSelect) {
        bodyFormatSelect.value = currentBodyFormat;
    }
    syncBodyFormatPickerDisplay();

    applyResponseStatusMeta(latestResponseData, !!tab.responseError);
    renderResponseHeaders(latestResponseData?.headers || {});
    renderResponseCookies(latestResponseData?.headers || {});
    updatePreviewButtonState();
    updateVisualizeButtonState();
    updateResponsePanels();
    if (currentResponseView === 'body') {
        renderResponseBody();
    }
}

function initRequestTabs() {
    if (requestTabs.length > 0) return;
    const initial = createNewTabState();
    ensureTabResponseState(initial);
    requestTabs = [initial];
    activeRequestTabId = initial.id;
    currentRequest = initial;
    renderRequestTabs();
    applyCurrentRequestToUI();
}

function getActiveTab() {
    return requestTabs.find(tab => tab.id === activeRequestTabId) || null;
}

function findRequestTabById(tabId) {
    return requestTabs.find((tab) => tab.id === tabId) || null;
}

function updateRequestWorkspaceState() {
    const hasActiveTab = !!getActiveTab();
    const toolbar = document.getElementById('requestToolbar');
    const requestBuilder = document.getElementById('requestBuilder');
    const panelResizer = document.getElementById('panelResizer');
    const responsePanel = document.getElementById('responsePanel');
    const emptyState = document.getElementById('requestWorkspaceEmpty');
    const saveBtn = document.getElementById('saveBtn');
    const tabsMenuToggle = document.getElementById('requestTabMenuToggle');

    if (toolbar) {
        toolbar.classList.toggle('hidden', !hasActiveTab);
    }
    if (requestBuilder) {
        requestBuilder.classList.toggle('hidden', !hasActiveTab);
    }
    if (panelResizer) {
        panelResizer.classList.toggle('hidden', !hasActiveTab);
    }
    if (responsePanel) {
        responsePanel.classList.toggle('hidden', !hasActiveTab);
    }
    if (emptyState) {
        emptyState.classList.toggle('hidden', hasActiveTab);
    }
    if (saveBtn) {
        saveBtn.disabled = !hasActiveTab;
    }
    if (tabsMenuToggle) {
        const hasTabs = requestTabs.length > 0;
        tabsMenuToggle.disabled = !hasTabs;
        if (!hasTabs) {
            hideRequestTabsDropdown(true);
        }
    }

    if (!hasActiveTab) {
        currentRequest = null;
        hideBodySearch(true);
        applyActiveTabResponseToUI();
    } else if (!currentRequest) {
        currentRequest = getActiveTab();
    }

    updateSendButtonState();
    renderCurrentRequestCurl();
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

    if (requestTabs.length === 0) {
        hideRequestTabsDropdown(true);
        return;
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
    updateRequestWorkspaceState();
    renderCurrentRequestCurl();
    requestAnimationFrame(() => {
        ensureActiveTabVisible();
        updateRequestTabsOverflowControls();
    });
}

window.createNewRequestTab = function() {
    syncCurrentRequestFromUI();
    const tab = createNewTabState();
    ensureTabResponseState(tab);
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
        if (removingActive && isSendingRequest) {
            window.cancelSendRequest(false);
        }
        requestTabs = [];
        activeRequestTabId = null;
        currentRequest = null;
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
    renderCurrentRequestCurl();
}

function applyCurrentRequestToUI() {
    const tab = getActiveTab();
    if (!tab) {
        updateRequestWorkspaceState();
        return;
    }
    ensureTabResponseState(tab);

    currentRequest = normalizeRequest(tab);
    Object.assign(tab, currentRequest);

    setMethodSelectValue(currentRequest.method);
    syncMethodPickerDisplay();
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
    updateRequestWorkspaceState();
    applyActiveTabResponseToUI();
    renderCurrentRequestCurl();
}

function attachRequestMetaListeners() {
    const methodSelect = document.getElementById('methodSelect');
    const urlInput = document.getElementById('urlInput');
    const nameInput = document.getElementById('requestNameInput');
    const rawFormatSelect = document.getElementById('rawFormatSelect');

    methodSelect.addEventListener('change', () => {
        syncMethodPickerDisplay();
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

    urlInput.addEventListener('keydown', (evt) => {
        if (evt.key !== 'Enter' || evt.isComposing) return;
        if (evt.shiftKey || evt.altKey || evt.ctrlKey || evt.metaKey) return;
        evt.preventDefault();
        window.sendRequest();
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
window.openSidebarFeature = function(name) {
    showToast(`${name} is coming soon`);
};

window.switchSidebar = function(tab, evt) {
    hideCollectionItemMenu();
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
    syncWorkspaceTopbarState();
    requestAnimationFrame(syncWorkspaceTopbarState);
};

function getLamaFeatureElements() {
    return {
        view: document.getElementById('lamaFeatureView'),
        frame: document.getElementById('lamaFeatureFrame'),
        status: document.getElementById('lamaFeatureStatus'),
        modelStatus: document.getElementById('lamaModelStatus'),
        empty: document.getElementById('lamaFeatureEmpty'),
        portInput: document.getElementById('lamaPortInput'),
        applyPortBtn: document.getElementById('lamaApplyPortBtn'),
        installBtn: document.getElementById('lamaInstallBtn'),
        uninstallBtn: document.getElementById('lamaUninstallBtn'),
        startBtn: document.getElementById('lamaStartBtn'),
        stopBtn: document.getElementById('lamaStopBtn'),
        reloadBtn: document.getElementById('lamaReloadBtn'),
        refreshBtn: document.getElementById('lamaRefreshStatusBtn'),
    };
}

function normalizeLamaPort(value, fallback = 8088) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
        return fallback;
    }
    return parsed;
}

function setTextContentById(id, value) {
    const node = document.getElementById(id);
    if (!node) return;
    node.textContent = value;
}

function formatByteSize(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let idx = 0;
    while (size >= 1024 && idx < units.length - 1) {
        size /= 1024;
        idx += 1;
    }
    const precision = idx <= 1 ? 0 : 1;
    return `${size.toFixed(precision)} ${units[idx]}`;
}

function renderLamaCommandDoc() {
    const port = normalizeLamaPort(lamaLastKnownPort, 8088);
    const execPath = lamaLastKnownExecutablePath || 'lama-cleaner';
    const device = lamaLastKnownDevice || 'cpu';
    const pythonPath = lamaLastKnownPythonPath || 'python3';
    const pipPath = pythonPath.endsWith('/python')
        ? `${pythonPath.slice(0, -'/python'.length)}/pip`
        : pythonPath.endsWith('/python3')
            ? `${pythonPath.slice(0, -'/python3'.length)}/pip`
            : 'pip';
    const installCmd = `${quoteShellArg(pythonPath)} -m pip install lama-cleaner`;
    const uninstallCmd = `${quoteShellArg(pythonPath)} -m pip uninstall -y lama-cleaner`;
    const startCmd = `${quoteShellArg(execPath)} --device=${device} --port=${port}`;
    const healthCmd = `curl -I http://127.0.0.1:${port}`;
    const modelCheckCmd = `ls -lh ${quoteShellArg(lamaLastKnownModelPath)}`;
    const modelFixCmd = `${quoteShellArg(pipPath)} install \"huggingface_hub<0.26\" --force-reinstall`;

    setTextContentById('lamaDocInstallCmd', installCmd);
    setTextContentById('lamaDocUninstallCmd', uninstallCmd);
    setTextContentById('lamaDocStartCmd', startCmd);
    setTextContentById('lamaDocHealthCmd', healthCmd);
    setTextContentById('lamaDocModelCheckCmd', modelCheckCmd);
    setTextContentById('lamaDocModelFixCmd', modelFixCmd);
}

async function hydrateLamaCommandDocRuntime() {
    try {
        const [runtime, samRuntime, status] = await Promise.all([
            invoke('get_lama_runtime_config'),
            invoke('get_sam_runtime_config'),
            invoke('get_lama_cleaner_status'),
        ]);
        lamaLastKnownPort = normalizeLamaPort(runtime?.port, lamaLastKnownPort);
        lamaLastKnownExecutablePath =
            runtime?.executable_path || runtime?.executablePath || lamaLastKnownExecutablePath;
        lamaLastKnownDevice = runtime?.device || lamaLastKnownDevice;
        lamaLastKnownPythonPath =
            samRuntime?.python_path || samRuntime?.pythonPath || lamaLastKnownPythonPath;
        lamaLastKnownModelPath = status?.model_path || status?.modelPath || lamaLastKnownModelPath;
        lamaLastKnownModelDownloaded = !!(status?.model_downloaded ?? status?.modelDownloaded);
        lamaLastKnownModelSizeBytes = Number(status?.model_size_bytes ?? status?.modelSizeBytes ?? lamaLastKnownModelSizeBytes ?? 0);
    } catch (error) {
        // ignore and keep last-known values
    }
    renderLamaCommandDoc();
}

window.openLamaCommandDoc = async function() {
    const modal = document.getElementById('lamaDocModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    renderLamaCommandDoc();
    await hydrateLamaCommandDocRuntime();
};

window.closeLamaCommandDoc = function() {
    const modal = document.getElementById('lamaDocModal');
    if (!modal) return;
    modal.classList.add('hidden');
};

document.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Escape') return;
    const modal = document.getElementById('lamaDocModal');
    if (!modal || modal.classList.contains('hidden')) return;
    evt.preventDefault();
    window.closeLamaCommandDoc();
});

function updateLamaFeatureUi(status = null, errorText = '') {
    const els = getLamaFeatureElements();
    if (!els.view) return;

    const hasStatus = !!status;
    const running = !!status?.running;
    const ready = !!status?.ready;
    const installed = !!status?.installed;
    const packageVersion = status?.package_version ? ` v${status.package_version}` : '';
    const fallbackPort = normalizeLamaPort(els.portInput?.value, lamaLastKnownPort);
    const port = normalizeLamaPort(status?.port, fallbackPort);
    if (hasStatus) {
        lamaLastKnownPort = port;
        lamaLastKnownExecutablePath = status?.executable_path || status?.executablePath || lamaLastKnownExecutablePath;
        lamaLastKnownDevice = status?.device || lamaLastKnownDevice;
        lamaLastKnownModelPath = status?.model_path || status?.modelPath || lamaLastKnownModelPath;
        lamaLastKnownModelDownloaded = !!(status?.model_downloaded ?? status?.modelDownloaded);
        lamaLastKnownModelSizeBytes = Number(status?.model_size_bytes ?? status?.modelSizeBytes ?? lamaLastKnownModelSizeBytes ?? 0);
        if (status?.python_path || status?.pythonPath) {
            lamaLastKnownPythonPath = status?.python_path || status?.pythonPath || lamaLastKnownPythonPath;
        }
    }
    const url = status?.url || `http://127.0.0.1:${port}`;
    const modelSizeText = formatByteSize(lamaLastKnownModelSizeBytes);
    renderLamaCommandDoc();

    if (els.status) {
        els.status.classList.remove('running', 'error');
        if (errorText) {
            els.status.classList.add('error');
            els.status.textContent = '状态异常';
        } else if (!installed) {
            els.status.textContent = '未安装';
        } else if (running && ready) {
            els.status.classList.add('running');
            els.status.textContent = `运行中${packageVersion} · ${url}`;
        } else if (running) {
            els.status.textContent = `启动中${packageVersion} · ${url}`;
        } else {
            els.status.textContent = `已安装${packageVersion} · 服务未启动`;
        }
    }

    if (els.modelStatus) {
        els.modelStatus.classList.remove('running', 'error');
        if (lamaLastKnownModelDownloaded) {
            els.modelStatus.classList.add('running');
            els.modelStatus.textContent = modelSizeText
                ? `模型已下载 · ${modelSizeText}`
                : '模型已下载';
        } else {
            els.modelStatus.classList.add('error');
            els.modelStatus.textContent = '模型未下载';
        }
    }

    if (els.portInput) {
        els.portInput.disabled = lamaServiceActionInProgress;
        if (hasStatus && document.activeElement !== els.portInput) {
            els.portInput.value = String(port);
        }
    }
    if (els.applyPortBtn) {
        els.applyPortBtn.disabled = lamaServiceActionInProgress || running;
    }
    if (els.installBtn) {
        els.installBtn.disabled = lamaServiceActionInProgress || installed;
    }
    if (els.uninstallBtn) {
        els.uninstallBtn.disabled = lamaServiceActionInProgress || !installed;
    }
    if (els.startBtn) {
        els.startBtn.disabled = lamaServiceActionInProgress || running || !installed;
    }
    if (els.stopBtn) {
        els.stopBtn.disabled = lamaServiceActionInProgress || !running;
    }
    if (els.reloadBtn) {
        els.reloadBtn.disabled = lamaServiceActionInProgress || !ready;
    }
    if (els.refreshBtn) {
        els.refreshBtn.disabled = lamaServiceActionInProgress;
    }

    if (els.empty) {
        if (errorText) {
            els.empty.innerHTML = `<div>服务状态查询失败</div><div>${escapeHtml(String(errorText))}</div>`;
            els.empty.classList.remove('hidden');
        } else if (!installed) {
            els.empty.innerHTML = '<div>lama-cleaner 未安装</div><div>点击“安装服务”后，再启动服务即可在应用内使用去水印。</div>';
            els.empty.classList.remove('hidden');
        } else if (!lamaLastKnownModelDownloaded) {
            els.empty.innerHTML = `<div>big-lama.pt 模型未下载</div><div>检测路径：<code>${escapeHtml(lamaLastKnownModelPath)}</code></div><div>可先启动服务让其自动下载，或执行“命令文档”里的模型检查命令。</div>`;
            els.empty.classList.remove('hidden');
        } else if (!running) {
            els.empty.innerHTML = `<div>lama-cleaner 服务未启动</div><div>点击“启动服务”，命令等价于：<code>lama-cleaner --device=cpu --port=${port}</code></div>`;
            els.empty.classList.remove('hidden');
        } else if (!ready) {
            els.empty.innerHTML = '<div>lama-cleaner 正在启动...</div><div>请稍等几秒后点击“刷新状态”</div>';
            els.empty.classList.remove('hidden');
        } else {
            els.empty.classList.add('hidden');
        }
    }

    if (els.frame) {
        if (running) {
            if (ready) {
                if (els.frame.dataset.baseUrl !== url) {
                    els.frame.dataset.baseUrl = url;
                    els.frame.src = url;
                } else if (!els.frame.src || els.frame.src === 'about:blank') {
                    els.frame.src = url;
                }
            }
        } else {
            els.frame.dataset.baseUrl = url;
            if (els.frame.src !== 'about:blank') {
                els.frame.src = 'about:blank';
            }
        }
    }
}

async function applyLamaPortConfigInternal(options = {}) {
    const { silent = false, stopIfRunning = true } = options;
    const els = getLamaFeatureElements();
    const inputPort = normalizeLamaPort(els.portInput?.value, 8088);

    if (els.portInput) {
        els.portInput.value = String(inputPort);
    }

    try {
        const runtime = await invoke('get_lama_runtime_config');
        const currentPort = normalizeLamaPort(runtime?.port, 8088);
        if (currentPort === inputPort) {
            return { changed: false, port: currentPort };
        }

        if (stopIfRunning) {
            try {
                await invoke('stop_lama_cleaner');
            } catch (error) {
                if (!silent) {
                    showToast(`停止旧端口服务失败: ${error}`);
                }
            }
        }

        const executablePath = runtime?.executable_path || runtime?.executablePath || 'lama-cleaner';
        const device = runtime?.device || 'cpu';
        await invoke('set_lama_runtime_config', {
            executablePath,
            device,
            port: inputPort,
        });
        return { changed: true, port: inputPort };
    } catch (error) {
        if (!silent) {
            showToast(`设置端口失败: ${error}`);
        }
        throw error;
    }
}

async function refreshLamaCleanerStatusInternal(options = {}) {
    const { silent = false } = options;
    try {
        const status = await invoke('get_lama_cleaner_status');
        updateLamaFeatureUi(status);
        return status;
    } catch (error) {
        updateLamaFeatureUi(null, String(error));
        if (!silent) {
            showToast(`获取 lama-cleaner 状态失败: ${error}`);
        }
        return null;
    }
}

window.refreshLamaCleanerStatus = async function() {
    await refreshLamaCleanerStatusInternal({ silent: false });
};

window.applyLamaPortConfig = async function() {
    if (lamaServiceActionInProgress) return;
    lamaServiceActionInProgress = true;
    updateLamaFeatureUi(null);
    try {
        const result = await applyLamaPortConfigInternal({ silent: false, stopIfRunning: true });
        if (result?.changed) {
            showToast(`lama-cleaner 端口已设置为 ${result.port}`);
        } else {
            showToast(`端口未变化，仍为 ${result?.port || 8088}`);
        }
    } finally {
        lamaServiceActionInProgress = false;
        await refreshLamaCleanerStatusInternal({ silent: true });
    }
};

window.startLamaCleanerService = async function() {
    if (lamaServiceActionInProgress) return;
    lamaServiceActionInProgress = true;
    updateLamaFeatureUi(null);
    try {
        await applyLamaPortConfigInternal({ silent: true, stopIfRunning: true });
        const status = await invoke('start_lama_cleaner');
        updateLamaFeatureUi(status);
        if (status?.ready) {
            showToast('lama-cleaner 已启动');
        } else {
            showToast('lama-cleaner 已拉起，正在等待服务就绪');
        }
        await refreshLamaCleanerStatusInternal({ silent: true });
    } catch (error) {
        updateLamaFeatureUi(null, String(error));
        showToast(`启动 lama-cleaner 失败: ${error}`);
    } finally {
        lamaServiceActionInProgress = false;
        await refreshLamaCleanerStatusInternal({ silent: true });
    }
};

window.installLamaCleanerService = async function() {
    if (lamaServiceActionInProgress) return;
    lamaServiceActionInProgress = true;
    updateLamaFeatureUi(null);
    try {
        await invoke('install_lama_cleaner');
        showToast('lama-cleaner 安装完成');
    } catch (error) {
        showToast(`安装 lama-cleaner 失败: ${error}`);
    } finally {
        lamaServiceActionInProgress = false;
        await refreshLamaCleanerStatusInternal({ silent: true });
    }
};

window.uninstallLamaCleanerService = async function() {
    if (lamaServiceActionInProgress) return;
    const shouldUninstall = window.confirm('确认卸载 lama-cleaner 吗？这会先停止服务。');
    if (!shouldUninstall) return;

    lamaServiceActionInProgress = true;
    updateLamaFeatureUi(null);
    try {
        await invoke('uninstall_lama_cleaner');
        showToast('lama-cleaner 已卸载');
    } catch (error) {
        showToast(`卸载 lama-cleaner 失败: ${error}`);
    } finally {
        lamaServiceActionInProgress = false;
        await refreshLamaCleanerStatusInternal({ silent: true });
    }
};

async function stopLamaCleanerServiceInternal(options = {}) {
    const { silent = false, force = false } = options;
    if (lamaServiceActionInProgress && !force) return;
    if (!force) {
        lamaServiceActionInProgress = true;
        updateLamaFeatureUi(null);
    }
    try {
        await invoke('stop_lama_cleaner');
        if (!silent) {
            showToast('lama-cleaner 已停止');
        }
    } catch (error) {
        if (!silent) {
            showToast(`停止 lama-cleaner 失败: ${error}`);
        }
    } finally {
        if (!force) {
            lamaServiceActionInProgress = false;
        }
        await refreshLamaCleanerStatusInternal({ silent: true });
    }
}

window.stopLamaCleanerService = async function() {
    await stopLamaCleanerServiceInternal({ silent: false, force: false });
};

window.reloadLamaCleanerFrame = function() {
    const els = getLamaFeatureElements();
    if (!els.frame) return;
    const baseUrl = els.frame.dataset.baseUrl || 'http://127.0.0.1:8088';
    const sep = baseUrl.includes('?') ? '&' : '?';
    els.frame.src = `${baseUrl}${sep}_t=${Date.now()}`;
};

function setFeatureView(feature) {
    const home = document.getElementById('featureHome');
    const postman = document.getElementById('postmanApp');
    const sam = document.getElementById('samFeatureView');
    const lama = document.getElementById('lamaFeatureView');
    const backBtn = document.getElementById('featureBackBtn');
    const previousFeature = activeFeature;
    const next = feature === 'postman' || feature === 'sam' || feature === 'lama' ? feature : 'home';

    if (!home || !postman || !sam || !lama || !backBtn) return;
    activeFeature = next;

    if (previousFeature === 'lama' && next !== 'lama') {
        void stopLamaCleanerServiceInternal({ silent: true, force: true });
    }

    if (next === 'postman') {
        home.classList.add('hidden');
        sam.classList.add('hidden');
        lama.classList.add('hidden');
        postman.classList.remove('hidden');
        backBtn.classList.remove('hidden');
        syncWorkspaceTopbarState();
        syncRightSidebarState();
        updateRequestTabsOverflowControls();
        updateRequestWorkspaceState();
        return;
    }

    if (next === 'sam') {
        home.classList.add('hidden');
        postman.classList.add('hidden');
        lama.classList.add('hidden');
        sam.classList.remove('hidden');
        backBtn.classList.remove('hidden');
        return;
    }

    if (next === 'lama') {
        home.classList.add('hidden');
        postman.classList.add('hidden');
        sam.classList.add('hidden');
        lama.classList.remove('hidden');
        backBtn.classList.remove('hidden');
        void refreshLamaCleanerStatusInternal({ silent: true });
        return;
    }

    postman.classList.add('hidden');
    sam.classList.add('hidden');
    lama.classList.add('hidden');
    home.classList.remove('hidden');
    backBtn.classList.add('hidden');
}

window.selectFeature = function(feature) {
    setFeatureView(feature);
};

window.backToFeatureHome = function() {
    setFeatureView('home');
};

function syncRightSidebarState() {
    const shell = document.getElementById('rightShell');
    const panel = document.getElementById('rightSidebarPanel');
    const resizer = document.getElementById('rightSidebarResizer');
    if (!shell || !panel || !resizer) return;

    const panelWidth = panel.getBoundingClientRect().width;
    const collapsed = shell.classList.contains('collapsed') || panelWidth < 8;
    shell.classList.toggle('collapsed', collapsed);
    resizer.classList.toggle('hidden', collapsed);
}

window.switchRightSidebar = function(tab, evt) {
    activeRightSidebarTab = tab || 'curl';
    document.querySelectorAll('.right-icon-sidebar .right-icon-item').forEach((item) => {
        item.classList.remove('active');
    });

    const target = getEventTarget(evt);
    const button = target?.closest ? target.closest('.right-icon-item') : null;
    if (button) {
        button.classList.add('active');
    }

    const panel = document.getElementById('rightSidebarPanel');
    const shell = document.getElementById('rightShell');
    if (panel && shell && (shell.classList.contains('collapsed') || panel.getBoundingClientRect().width < 8)) {
        shell.classList.remove('collapsed');
        panel.style.width = '320px';
    }

    const curlPanel = document.getElementById('rightCurlPanel');
    if (curlPanel) {
        curlPanel.classList.toggle('hidden', activeRightSidebarTab !== 'curl');
    }

    syncRightSidebarState();
    renderCurrentRequestCurl();
};

function escapeShellSingleQuotes(value) {
    return String(value ?? '').replace(/'/g, `'\"'\"'`);
}

function quoteShellArg(value) {
    return `'${escapeShellSingleQuotes(value)}'`;
}

function hasHeaderIgnoreCase(headers, headerName) {
    const target = String(headerName || '').toLowerCase();
    return headers.some((entry) => String(entry.key || '').toLowerCase() === target);
}

function pushHeaderIfMissing(headers, headerName, value) {
    if (!headerName || value == null || value === '') return;
    if (hasHeaderIgnoreCase(headers, headerName)) return;
    headers.push({ key: String(headerName), value: String(value) });
}

function collectBodyFieldsForCurl(fields) {
    if (!Array.isArray(fields)) return [];
    return fields.filter((item) =>
        item &&
        item.enabled !== false &&
        String(item.key || '').trim().length > 0
    );
}

function buildCurlCommandFromRequest(tab) {
    if (!tab) return 'No active request tab.';

    const method = normalizeMethodValue(tab.method || 'GET');
    const url = (tab.url || '').trim();
    const headers = (Array.isArray(tab.headers) ? tab.headers : [])
        .filter((item) => item && item.enabled !== false && String(item.key || '').trim())
        .map((item) => ({
            key: String(item.key || '').trim(),
            value: String(item.value ?? '').trim()
        }));

    const bodyType = tab.bodyType || 'none';
    const bodyLines = [];
    if (bodyType === 'raw') {
        const rawBody = tab.body || '';
        if (rawBody) {
            bodyLines.push(`  --data-raw ${quoteShellArg(rawBody)}`);
        }
        pushHeaderIfMissing(headers, 'Content-Type', getRawContentType(tab.rawFormat || 'json'));
    } else if (bodyType === 'x-www-form-urlencoded') {
        const fields = collectBodyFieldsForCurl(tab.bodyFields);
        const encoded = fields
            .map((field) =>
                `${encodeURIComponent(String(field.key ?? ''))}=${encodeURIComponent(String(field.value ?? ''))}`
            )
            .join('&');
        if (encoded) {
            bodyLines.push(`  --data-raw ${quoteShellArg(encoded)}`);
        }
        pushHeaderIfMissing(headers, 'Content-Type', 'application/x-www-form-urlencoded');
    } else if (bodyType === 'form-data') {
        const fields = collectBodyFieldsForCurl(tab.bodyFields);
        fields.forEach((field) => {
            const pair = `${String(field.key ?? '')}=${String(field.value ?? '')}`;
            bodyLines.push(`  -F ${quoteShellArg(pair)}`);
        });
    } else if (bodyType === 'binary') {
        const binary = tab.binaryBody || '';
        if (binary) {
            bodyLines.push(`  --data-binary ${quoteShellArg(binary)}`);
        }
        pushHeaderIfMissing(headers, 'Content-Type', 'application/octet-stream');
    } else if (bodyType === 'graphql') {
        const query = String(tab.graphqlQuery || '');
        const rawVars = String(tab.graphqlVariables || '').trim();
        let variables = {};
        if (rawVars) {
            try {
                variables = JSON.parse(rawVars);
            } catch {
                variables = rawVars;
            }
        }
        const payload = JSON.stringify({ query, variables });
        bodyLines.push(`  --data-raw ${quoteShellArg(payload)}`);
        pushHeaderIfMissing(headers, 'Content-Type', 'application/json');
    }

    const lines = [];
    lines.push(`curl ${quoteShellArg(url || 'https://example.com')}`);
    if (method !== 'GET') {
        lines.push(`  -X ${method}`);
    }

    headers.forEach((header) => {
        lines.push(`  -H ${quoteShellArg(`${header.key}: ${header.value}`)}`);
    });
    bodyLines.forEach((line) => lines.push(line));

    return lines.join(' \\\n');
}

function renderCurrentRequestCurl() {
    const preview = document.getElementById('rightCurlPreview');
    if (!preview) return;
    if (activeRightSidebarTab !== 'curl') return;

    const tab = getActiveTab();
    preview.textContent = buildCurlCommandFromRequest(tab);
}

window.copyCurrentRequestCurl = async function() {
    const preview = document.getElementById('rightCurlPreview');
    if (!preview) return;
    const text = preview.textContent || '';
    if (!text.trim()) {
        showToast('No cURL content to copy', 'error');
        return;
    }

    try {
        if (navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const temp = document.createElement('textarea');
            temp.value = text;
            document.body.appendChild(temp);
            temp.select();
            document.execCommand('copy');
            temp.remove();
        }
        showToast('cURL copied');
    } catch (error) {
        console.error('Copy cURL error:', error);
        showToast('Failed to copy cURL', 'error');
    }
};

// ==================== Collections 管理 ====================
async function loadCollections() {
    try {
        const data = await invoke('get_collections');
        collections = normalizeCollectionsState(data || []);
        renderCollections();
    } catch (error) {
        console.error('Load collections error:', error);
        // 使用默认数据
        collections = normalizeCollectionsState([
            {
                id: '1',
                name: 'chat',
                type: 'folder',
                parent_id: null,
                children: [
                    { id: '1-1', name: '获取消息列表', method: 'GET', url: '/api/chat/messages' },
                    { id: '1-2', name: '发送消息', method: 'POST', url: '/api/chat/send' }
                ]
            },
            {
                id: '2',
                name: 'common',
                type: 'folder',
                parent_id: null,
                children: [
                    { id: '2-1', name: '获取配置', method: 'GET', url: '/api/config' }
                ]
            }
        ]);
        renderCollections();
    }
}

function normalizeCollectionRequestRecord(request) {
    const fallbackId = request?.id != null ? String(request.id) : generateCollectionEntityId('req');
    const payload = getCollectionRequestPayload({
        ...request,
        id: fallbackId
    });
    const method = normalizeMethodValue(payload.method || request?.method || 'GET');
    const url = payload.url || request?.url || '';
    const name = (request?.name ?? payload.name ?? '').toString();
    const normalizedPayload = {
        ...payload,
        id: fallbackId,
        name,
        method,
        url
    };

    return {
        id: fallbackId,
        name,
        method,
        url,
        request_data: JSON.stringify(normalizedPayload)
    };
}

function getCollectionFolderParentId(folder) {
    const raw = folder?.parent_id ?? folder?.parentId ?? null;
    if (raw == null) return null;
    const normalized = String(raw).trim();
    return normalized ? normalized : null;
}

function normalizeCollectionFolderRecord(folder) {
    const resolvedId = folder?.id != null ? String(folder.id) : generateCollectionEntityId('folder');
    const parentId = getCollectionFolderParentId(folder);
    const normalized = {
        ...folder,
        id: resolvedId,
        name: (folder?.name || '').toString(),
        parent_id: parentId,
        children: Array.isArray(folder?.children) ? folder.children : []
    };
    if ('parentId' in normalized) {
        delete normalized.parentId;
    }
    return normalized;
}

function normalizeCollectionsState(rawCollections = []) {
    return (Array.isArray(rawCollections) ? rawCollections : []).map((folder) => normalizeCollectionFolderRecord(folder));
}

function serializeCollectionsForPersist() {
    return collections.map((folder) => ({
        id: folder?.id != null ? String(folder.id) : generateCollectionEntityId('folder'),
        name: (folder?.name || '').toString(),
        parent_id: getCollectionFolderParentId(folder),
        children: Array.isArray(folder?.children)
            ? folder.children.map((request) => normalizeCollectionRequestRecord(request))
            : []
    }));
}

async function persistCollectionsState(actionLabel = 'save collections') {
    try {
        const payload = serializeCollectionsForPersist();
        const saved = await invoke('replace_collections', { collections: payload });
        collections = normalizeCollectionsState(Array.isArray(saved) ? saved : payload);
        renderCollections();
        return true;
    } catch (error) {
        console.error(`Persist collections failed while trying to ${actionLabel}:`, error);
        const reason = error?.message || String(error || '');
        showToast(reason ? `Failed to ${actionLabel}: ${reason}` : `Failed to ${actionLabel}`, 'error');
        await loadCollections();
        return false;
    }
}

function generateCollectionEntityId(prefix = 'id') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function findCollectionFolderById(folderId) {
    const folderIdStr = String(folderId);
    return collections.find((folder) => String(folder?.id) === folderIdStr) || null;
}

function findCollectionRequestLocation(requestId) {
    const requestIdStr = String(requestId);
    for (let i = 0; i < collections.length; i += 1) {
        const folder = collections[i];
        const children = Array.isArray(folder?.children) ? folder.children : [];
        const requestIndex = children.findIndex((child) => String(child?.id) === requestIdStr);
        if (requestIndex > -1) {
            return {
                folder,
                folderIndex: i,
                request: children[requestIndex],
                requestIndex
            };
        }
    }
    return null;
}

function getCollectionRequestPayload(request) {
    let requestData = {};
    if (request?.request_data) {
        try {
            requestData = JSON.parse(request.request_data);
        } catch {
            requestData = {};
        }
    }

    return normalizeRequest({
        ...requestData,
        name: request?.name || requestData.name || '',
        method: request?.method || requestData.method || 'GET',
        url: request?.url || requestData.url || '',
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
}

function clearCollectionMenuRowState() {
    document.querySelectorAll('.tree-item.menu-open').forEach((item) => {
        item.classList.remove('menu-open');
    });
}

function ensureCollectionItemMenu() {
    let menu = document.getElementById('collectionItemMenu');
    if (menu) return menu;

    menu = document.createElement('div');
    menu.id = 'collectionItemMenu';
    menu.className = 'collection-item-menu hidden';
    document.body.appendChild(menu);
    return menu;
}

function hideCollectionItemMenu() {
    clearCollectionMenuRowState();
    activeCollectionMenuState = null;
    const menu = document.getElementById('collectionItemMenu');
    if (menu) {
        menu.classList.add('hidden');
        menu.innerHTML = '';
    }
}

function positionCollectionItemMenu(anchor, menu) {
    const rect = anchor.getBoundingClientRect();
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.classList.remove('hidden');
    const menuRect = menu.getBoundingClientRect();

    const spacing = 6;
    let left = rect.right - menuRect.width;
    let top = rect.bottom + spacing;
    if (left < spacing) left = spacing;
    if (left + menuRect.width > window.innerWidth - spacing) {
        left = window.innerWidth - menuRect.width - spacing;
    }
    if (top + menuRect.height > window.innerHeight - spacing) {
        top = rect.top - menuRect.height - spacing;
    }
    if (top < spacing) top = spacing;

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
}

function getCollectionMenuItems(state) {
    if (state.type === 'folder') {
        return [
            { action: 'folder_add_request', label: 'Add Request' },
            { action: 'folder_add_folder', label: 'Add Folder' },
            { action: 'folder_rename', label: 'Rename' },
            { action: 'folder_delete', label: 'Delete', danger: true }
        ];
    }

    return [
        { action: 'request_rename', label: 'Rename' },
        { action: 'request_duplicate', label: 'Duplicate' },
        { action: 'request_delete', label: 'Delete', danger: true }
    ];
}

function renderCollectionItemMenu() {
    if (!activeCollectionMenuState) {
        hideCollectionItemMenu();
        return;
    }

    const anchor = activeCollectionMenuState.anchor;
    if (!anchor || !document.body.contains(anchor)) {
        hideCollectionItemMenu();
        return;
    }

    clearCollectionMenuRowState();
    activeCollectionMenuState.row?.classList.add('menu-open');

    const menu = ensureCollectionItemMenu();
    menu.innerHTML = '';

    const list = document.createElement('div');
    list.className = 'collection-item-menu-list';
    const menuStateSnapshot = activeCollectionMenuState
        ? {
            type: activeCollectionMenuState.type,
            folderId: activeCollectionMenuState.folderId,
            requestId: activeCollectionMenuState.requestId
        }
        : null;
    getCollectionMenuItems(activeCollectionMenuState).forEach((item) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `collection-item-menu-btn ${item.danger ? 'danger' : ''}`;
        btn.textContent = item.label;
        btn.addEventListener('click', async (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            await handleCollectionMenuAction(item.action, menuStateSnapshot);
        });
        list.appendChild(btn);
    });
    menu.appendChild(list);

    positionCollectionItemMenu(anchor, menu);
}

window.toggleCollectionItemMenu = function(type, folderId, requestId = '', evt) {
    if (evt) {
        evt.preventDefault();
        evt.stopPropagation();
    }

    const anchor = getEventTarget(evt);
    if (!anchor) return;

    const folderIdStr = String(folderId || '');
    const requestIdStr = requestId != null ? String(requestId) : '';
    const key = `${type}:${folderIdStr}:${requestIdStr}`;

    if (activeCollectionMenuState?.key === key) {
        hideCollectionItemMenu();
        return;
    }

    activeCollectionMenuState = {
        key,
        type,
        folderId: folderIdStr,
        requestId: requestIdStr,
        anchor,
        row: anchor.closest('.tree-item')
    };
    renderCollectionItemMenu();
};

function generateDuplicatedRequestName(baseName, siblings = []) {
    const sourceName = (baseName || 'Untitled request').trim() || 'Untitled request';
    const seed = `${sourceName} Copy`;
    const existing = new Set(
        siblings.map((item) => String(item?.name || item?.url || '').trim().toLowerCase()).filter(Boolean)
    );
    if (!existing.has(seed.toLowerCase())) return seed;

    let index = 2;
    while (existing.has(`${seed} ${index}`.toLowerCase())) {
        index += 1;
    }
    return `${seed} ${index}`;
}

async function addRequestToFolder(folderId) {
    const folder = findCollectionFolderById(folderId);
    if (!folder) return;

    const requestId = generateCollectionEntityId('req');
    const payload = normalizeRequest({
        id: requestId,
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
        isCustomName: false
    });

    const record = {
        id: requestId,
        name: '',
        method: payload.method,
        url: payload.url,
        request_data: JSON.stringify(payload)
    };

    if (!Array.isArray(folder.children)) folder.children = [];
    folder.children.push(record);
    collapsedCollectionFolderIds.delete(String(folderId));
    renderCollections();
    openRequestFromSource('collection', requestId, payload);
    if (await persistCollectionsState('add request')) {
        showToast('Request added');
    }
}

async function renameCollectionFolder(folderId) {
    const folder = findCollectionFolderById(folderId);
    if (!folder) return;

    const prompted = await openTextPromptModal('Rename folder', folder.name || '');
    if (prompted == null) return;
    const nextName = prompted.trim();
    if (!nextName) return;
    folder.name = nextName;
    renderCollections();
    if (await persistCollectionsState('rename folder')) {
        showToast('Folder renamed');
    }
}

async function deleteCollectionFolder(folderId) {
    const targetId = String(folderId);
    const folder = findCollectionFolderById(targetId);
    if (!folder) return;
    const folderName = folder?.name || 'this folder';
    const confirmed = await openConfirmModal(`Delete "${folderName}" and all requests inside it?`, 'Delete Folder');
    if (!confirmed) return;

    const removedFolderIds = new Set([targetId]);
    let changed = true;
    while (changed) {
        changed = false;
        collections.forEach((item) => {
            const id = String(item?.id || '');
            const parentId = getCollectionFolderParentId(item);
            if (!id || !parentId) return;
            if (removedFolderIds.has(parentId) && !removedFolderIds.has(id)) {
                removedFolderIds.add(id);
                changed = true;
            }
        });
    }

    const removedRequestIds = new Set();
    collections.forEach((item) => {
        const id = String(item?.id || '');
        if (!removedFolderIds.has(id)) return;
        const children = Array.isArray(item?.children) ? item.children : [];
        children.forEach((request) => {
            if (request?.id != null) {
                removedRequestIds.add(String(request.id));
            }
        });
    });

    collections = collections.filter((item) => !removedFolderIds.has(String(item?.id || '')));
    removedFolderIds.forEach((id) => collapsedCollectionFolderIds.delete(id));

    if (removedRequestIds.size > 0) {
        requestTabs.forEach((tab) => {
            if (tab.sourceType === 'collection' && removedRequestIds.has(String(tab.sourceId))) {
                tab.sourceType = '';
                tab.sourceId = '';
            }
        });
        renderRequestTabs();
    }

    renderCollections();
    if (await persistCollectionsState('delete folder')) {
        showToast('Folder deleted');
    }
}

async function renameCollectionRequest(requestId) {
    const location = findCollectionRequestLocation(requestId);
    if (!location) return;

    const currentLabel = location.request.name || location.request.url || 'Untitled request';
    const prompted = await openTextPromptModal('Rename request', currentLabel);
    if (prompted == null) return;
    const nextName = prompted.trim();
    if (!nextName) return;

    const payload = getCollectionRequestPayload(location.request);
    payload.name = nextName;
    payload.isCustomName = true;
    location.request.name = nextName;
    location.request.request_data = JSON.stringify(payload);

    requestTabs.forEach((tab) => {
        if (tab.sourceType === 'collection' && String(tab.sourceId) === String(requestId) && !tab.isCustomName) {
            tab.name = nextName;
        }
    });

    renderCollections();
    renderRequestTabs();
    if (await persistCollectionsState('rename request')) {
        showToast('Request renamed');
    }
}

async function deleteCollectionRequest(requestId) {
    const location = findCollectionRequestLocation(requestId);
    if (!location) return;

    const requestName = location.request.name || location.request.url || 'this request';
    const confirmed = await openConfirmModal(`Delete "${requestName}"?`, 'Delete Request');
    if (!confirmed) return;

    location.folder.children.splice(location.requestIndex, 1);
    requestTabs.forEach((tab) => {
        if (tab.sourceType === 'collection' && String(tab.sourceId) === String(requestId)) {
            tab.sourceType = '';
            tab.sourceId = '';
        }
    });

    renderCollections();
    renderRequestTabs();
    if (await persistCollectionsState('delete request')) {
        showToast('Request deleted');
    }
}

async function duplicateCollectionRequest(requestId) {
    const location = findCollectionRequestLocation(requestId);
    if (!location) return;

    const payload = getCollectionRequestPayload(location.request);
    const duplicatedName = generateDuplicatedRequestName(
        payload.name || payload.url || location.request.name || location.request.url || 'Untitled request',
        location.folder.children
    );
    const nextId = generateCollectionEntityId('req');

    const duplicatedPayload = normalizeRequest({
        ...payload,
        id: nextId,
        name: duplicatedName,
        isCustomName: true,
        sourceType: '',
        sourceId: ''
    });

    const duplicatedRequest = {
        id: nextId,
        name: duplicatedName,
        method: duplicatedPayload.method || 'GET',
        url: duplicatedPayload.url || '',
        request_data: JSON.stringify(duplicatedPayload)
    };

    location.folder.children.splice(location.requestIndex + 1, 0, duplicatedRequest);
    collapsedCollectionFolderIds.delete(String(location.folder.id));
    renderCollections();
    if (await persistCollectionsState('duplicate request')) {
        showToast('Request duplicated');
    }
}

async function handleCollectionMenuAction(action, state) {
    if (!state) return;
    hideCollectionItemMenu();

    switch (action) {
        case 'folder_add_request':
            await addRequestToFolder(state.folderId);
            break;
        case 'folder_add_folder':
            await window.createCollectionFolder(state.folderId);
            break;
        case 'folder_rename':
            await renameCollectionFolder(state.folderId);
            break;
        case 'folder_delete':
            await deleteCollectionFolder(state.folderId);
            break;
        case 'request_rename':
            await renameCollectionRequest(state.requestId);
            break;
        case 'request_duplicate':
            await duplicateCollectionRequest(state.requestId);
            break;
        case 'request_delete':
            await deleteCollectionRequest(state.requestId);
            break;
        default:
            break;
    }
}

function clearCollectionDropTargets() {
    document.querySelectorAll('.drop-target').forEach((node) => {
        node.classList.remove('drop-target');
    });
    document.querySelectorAll('.drop-target-before').forEach((node) => {
        node.classList.remove('drop-target-before');
    });
    document.querySelectorAll('.drop-target-after').forEach((node) => {
        node.classList.remove('drop-target-after');
    });
}

function findCollectionDropElementByFolderId(folderId) {
    if (!folderId) return null;
    const all = document.querySelectorAll('.tree-folder[data-folder-id], .tree-children[data-folder-id]');
    for (let i = 0; i < all.length; i += 1) {
        if (String(all[i]?.dataset?.folderId || '') === String(folderId)) {
            return all[i];
        }
    }
    return null;
}

function findCollectionRequestElementById(requestId) {
    if (!requestId) return null;
    const all = document.querySelectorAll('.tree-request[data-request-id]');
    for (let i = 0; i < all.length; i += 1) {
        if (String(all[i]?.dataset?.requestId || '') === String(requestId)) {
            return all[i];
        }
    }
    return null;
}

function getCollectionDropInfoFromPoint(clientX, clientY) {
    const stack = typeof document.elementsFromPoint === 'function'
        ? document.elementsFromPoint(clientX, clientY)
        : [document.elementFromPoint(clientX, clientY)].filter(Boolean);
    if (!stack || stack.length === 0) {
        return null;
    }

    for (let i = 0; i < stack.length; i += 1) {
        const node = stack[i];
        if (!node || node === document.body || node === document.documentElement) continue;

        const requestRow = node.closest?.('.tree-request[data-folder-id][data-request-id]');
        if (requestRow?.dataset?.folderId && requestRow?.dataset?.requestId) {
            const rect = requestRow.getBoundingClientRect();
            const insertAfter = clientY >= (rect.top + rect.height / 2);
            return {
                folderId: String(requestRow.dataset.folderId),
                requestId: String(requestRow.dataset.requestId),
                insertAfter
            };
        }

        const folderNode = node.closest?.('.tree-folder[data-folder-id], .tree-children[data-folder-id]');
        if (folderNode?.dataset?.folderId) {
            return {
                folderId: String(folderNode.dataset.folderId),
                requestId: '',
                insertAfter: false
            };
        }
    }
    return null;
}

function areCollectionDropInfosEqual(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return String(a.folderId || '') === String(b.folderId || '')
        && String(a.requestId || '') === String(b.requestId || '')
        && !!a.insertAfter === !!b.insertAfter;
}

function setCollectionPointerDropTarget(dropInfo) {
    if (areCollectionDropInfosEqual(pointerDragHoverInfo, dropInfo)) return;

    pointerDragHoverInfo = dropInfo || null;
    clearCollectionDropTargets();
    if (!pointerDragHoverInfo?.folderId) {
        logCollectionDrag('pointer-hover-clear', {});
        return;
    }

    if (pointerDragHoverInfo.requestId) {
        const requestNode = findCollectionRequestElementById(pointerDragHoverInfo.requestId);
        if (requestNode) {
            requestNode.classList.add('drop-target');
            requestNode.classList.add(pointerDragHoverInfo.insertAfter ? 'drop-target-after' : 'drop-target-before');
        }
    } else {
        const folderNode = findCollectionDropElementByFolderId(pointerDragHoverInfo.folderId);
        if (folderNode) {
            folderNode.classList.add('drop-target');
        }
    }
    logCollectionDrag('pointer-hover-target', pointerDragHoverInfo);
}

function setCollectionPointerCursorLock(enabled) {
    const root = document.documentElement;
    const body = document.body;
    if (!root || !body) return;

    root.classList.toggle('collection-pointer-cursor-lock', enabled);
    body.classList.toggle('collection-pointer-cursor-lock', enabled);

    if (enabled) {
        root.style.cursor = 'grabbing';
        body.style.cursor = 'grabbing';
        return;
    }

    root.style.cursor = '';
    body.style.cursor = '';
}

function extractCollectionDragPayload(evt) {
    if (draggingCollectionRequestState) return draggingCollectionRequestState;
    const data = evt?.dataTransfer?.getData('application/json') || evt?.dataTransfer?.getData('text/plain');
    if (!data) {
        logCollectionDrag('extract-payload-empty', {
            hasDataTransfer: !!evt?.dataTransfer
        });
        return null;
    }
    try {
        const parsed = JSON.parse(data);
        if (!parsed?.requestId) {
            logCollectionDrag('extract-payload-invalid', { parsed });
            return null;
        }
        return {
            requestId: String(parsed.requestId),
            fromFolderId: parsed?.fromFolderId != null ? String(parsed.fromFolderId) : ''
        };
    } catch {
        logCollectionDrag('extract-payload-json-error', { raw: data });
        return null;
    }
}

function canDropCollectionRequest(requestId, dropInfo) {
    const targetFolderId = String(dropInfo?.folderId || '');
    if (!targetFolderId) {
        logCollectionDrag('can-drop-missing-target-folder', { requestId, dropInfo });
        return false;
    }

    const location = findCollectionRequestLocation(requestId);
    if (!location) {
        logCollectionDrag('can-drop-location-missing', { requestId, dropInfo });
        return false;
    }

    const sourceFolderId = String(location.folder?.id || '');
    if (sourceFolderId !== targetFolderId) {
        return true;
    }

    const sourceChildren = Array.isArray(location.folder?.children) ? location.folder.children : [];
    const sourceIndex = location.requestIndex;
    if (sourceIndex < 0 || sourceIndex >= sourceChildren.length) {
        return false;
    }

    const targetRequestId = String(dropInfo?.requestId || '');
    if (!targetRequestId) {
        return sourceIndex !== sourceChildren.length - 1;
    }

    if (targetRequestId === requestId) {
        return false;
    }

    const targetIndex = sourceChildren.findIndex((item) => String(item?.id) === targetRequestId);
    if (targetIndex < 0) {
        return false;
    }

    let nextIndex = targetIndex + (dropInfo.insertAfter ? 1 : 0);
    if (sourceIndex < nextIndex) {
        nextIndex -= 1;
    }
    return nextIndex !== sourceIndex;
}

async function moveCollectionRequestToFolder(requestId, dropInfo) {
    const targetFolderId = String(dropInfo?.folderId || '');
    const targetRequestId = String(dropInfo?.requestId || '');
    const insertAfter = !!dropInfo?.insertAfter;
    logCollectionDrag('move-start', { requestId, targetFolderId, targetRequestId, insertAfter });
    const location = findCollectionRequestLocation(requestId);
    if (!location) {
        logCollectionDrag('move-failed-location-missing', { requestId, targetFolderId });
        return;
    }

    const sourceFolder = location.folder;
    const targetFolder = findCollectionFolderById(targetFolderId);
    if (!sourceFolder || !targetFolder) {
        logCollectionDrag('move-failed-folder-missing', {
            requestId,
            sourceFolderId: sourceFolder?.id,
            targetFolderId
        });
        return;
    }

    if (!canDropCollectionRequest(requestId, {
        folderId: targetFolderId,
        requestId: targetRequestId,
        insertAfter
    })) {
        logCollectionDrag('move-skipped-noop', { requestId, targetFolderId, targetRequestId, insertAfter });
        return;
    }

    const sourceChildren = Array.isArray(sourceFolder.children) ? sourceFolder.children : [];
    const requestIndex = location.requestIndex;
    if (requestIndex < 0 || requestIndex >= sourceChildren.length) {
        logCollectionDrag('move-failed-bad-index', {
            requestId,
            requestIndex,
            sourceLength: sourceChildren.length
        });
        return;
    }

    const [request] = sourceChildren.splice(requestIndex, 1);
    if (!Array.isArray(targetFolder.children)) targetFolder.children = [];
    const targetChildren = targetFolder.children;

    let insertIndex = targetChildren.length;
    if (targetRequestId) {
        const targetIndex = targetChildren.findIndex((item) => String(item?.id) === targetRequestId);
        if (targetIndex > -1) {
            insertIndex = targetIndex + (insertAfter ? 1 : 0);
        }
    }
    if (insertIndex < 0) insertIndex = 0;
    if (insertIndex > targetChildren.length) insertIndex = targetChildren.length;
    targetChildren.splice(insertIndex, 0, request);

    collapsedCollectionFolderIds.delete(String(targetFolderId));
    renderCollections();
    const persisted = await persistCollectionsState('move request');
    logCollectionDrag('move-persist-result', {
        requestId,
        fromFolderId: String(sourceFolder.id),
        toFolderId: String(targetFolderId),
        targetRequestId,
        insertAfter,
        persisted
    });
    if (persisted) {
        showToast('Request moved');
    }
}

window.handleCollectionRequestDragStart = function(requestId, fromFolderId, evt) {
    if (draggingCollectionRequestClearTimer) {
        clearTimeout(draggingCollectionRequestClearTimer);
        draggingCollectionRequestClearTimer = null;
    }
    draggingCollectionRequestState = {
        requestId: String(requestId),
        fromFolderId: String(fromFolderId)
    };
    logCollectionDrag('dragstart', draggingCollectionRequestState);

    const target = getEventTarget(evt);
    const row = target ? target.closest('.tree-item') : null;
    if (row) row.classList.add('dragging');

    if (evt?.dataTransfer) {
        evt.dataTransfer.effectAllowed = 'move';
        const payloadText = JSON.stringify(draggingCollectionRequestState);
        evt.dataTransfer.setData('application/json', payloadText);
        evt.dataTransfer.setData('text/plain', payloadText);
    }

    hideCollectionItemMenu();
};

window.handleCollectionRequestDragEnd = function(evt) {
    const payload = draggingCollectionRequestState ? { ...draggingCollectionRequestState } : null;
    logCollectionDrag('dragend', { payload });
    clearCollectionDropTargets();
    const target = getEventTarget(evt);
    const row = target ? target.closest('.tree-item') : null;
    if (row) row.classList.remove('dragging');
    if (draggingCollectionRequestClearTimer) {
        clearTimeout(draggingCollectionRequestClearTimer);
    }
    draggingCollectionRequestClearTimer = setTimeout(() => {
        draggingCollectionRequestState = null;
        draggingCollectionRequestClearTimer = null;
    }, 120);
};

window.handleCollectionFolderDragOver = function(folderId, evt) {
    const payload = extractCollectionDragPayload(evt);
    if (!payload) {
        logCollectionDrag('dragover-no-payload', { folderId });
        return;
    }
    if (!canDropCollectionRequest(payload.requestId, { folderId, requestId: '', insertAfter: false })) {
        logCollectionDrag('dragover-rejected', {
            folderId,
            requestId: payload.requestId
        });
        return;
    }

    evt.preventDefault();
    if (evt.dataTransfer) evt.dataTransfer.dropEffect = 'move';
    const target = evt.currentTarget;
    if (target) target.classList.add('drop-target');
    logCollectionDrag('dragover-accepted', {
        folderId,
        requestId: payload.requestId
    });
};

window.handleCollectionFolderDragLeave = function(evt) {
    const target = evt.currentTarget;
    if (!target) return;
    if (evt.relatedTarget && target.contains(evt.relatedTarget)) return;
    target.classList.remove('drop-target');
};

window.handleCollectionFolderDrop = async function(folderId, evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const payload = extractCollectionDragPayload(evt);
    clearCollectionDropTargets();
    if (!payload) {
        logCollectionDrag('drop-no-payload', { folderId });
        return;
    }
    logCollectionDrag('drop', {
        folderId,
        requestId: payload.requestId,
        fromFolderId: payload.fromFolderId
    });
    await moveCollectionRequestToFolder(payload.requestId, {
        folderId,
        requestId: '',
        insertAfter: false
    });
    if (draggingCollectionRequestClearTimer) {
        clearTimeout(draggingCollectionRequestClearTimer);
        draggingCollectionRequestClearTimer = null;
    }
    draggingCollectionRequestState = null;
};

window.handleCollectionRequestPointerDown = function(requestId, fromFolderId, evt) {
    if (!evt) return;
    if (typeof evt.button === 'number' && evt.button !== 0) return;
    const target = getEventTarget(evt);
    if (target?.closest?.('.tree-item-action-btn')) return;

    pendingCollectionPointerDrag = {
        requestId: String(requestId),
        fromFolderId: String(fromFolderId),
        startX: evt.clientX,
        startY: evt.clientY,
        row: target ? target.closest('.tree-request') : null
    };
    setCollectionPointerCursorLock(true);
    activeCollectionPointerDrag = null;
    setCollectionPointerDropTarget(null);
    logCollectionDrag('pointer-down', {
        requestId: String(requestId),
        fromFolderId: String(fromFolderId)
    });
};

function activateCollectionPointerDrag() {
    if (!pendingCollectionPointerDrag) return;
    activeCollectionPointerDrag = {
        requestId: pendingCollectionPointerDrag.requestId,
        fromFolderId: pendingCollectionPointerDrag.fromFolderId,
        row: pendingCollectionPointerDrag.row || null
    };
    pendingCollectionPointerDrag = null;
    draggingCollectionRequestState = {
        requestId: activeCollectionPointerDrag.requestId,
        fromFolderId: activeCollectionPointerDrag.fromFolderId
    };
    document.documentElement.classList.add('collection-pointer-dragging');
    document.body.classList.add('collection-pointer-dragging');
    document.documentElement.style.cursor = 'grabbing';
    document.body.style.cursor = 'grabbing';
    if (activeCollectionPointerDrag.row) {
        activeCollectionPointerDrag.row.classList.add('dragging');
    }
    logCollectionDrag('pointer-drag-start', {
        requestId: activeCollectionPointerDrag.requestId,
        fromFolderId: activeCollectionPointerDrag.fromFolderId
    });
}

window.handleCollectionPointerMove = function(evt) {
    if (!pendingCollectionPointerDrag && !activeCollectionPointerDrag) return;
    if (!evt) return;

    if (pendingCollectionPointerDrag) {
        const dx = Math.abs(evt.clientX - pendingCollectionPointerDrag.startX);
        const dy = Math.abs(evt.clientY - pendingCollectionPointerDrag.startY);
        if (Math.hypot(dx, dy) >= COLLECTION_DRAG_START_THRESHOLD) {
            activateCollectionPointerDrag();
        } else {
            return;
        }
    }

    if (!activeCollectionPointerDrag) return;

    const dropInfo = getCollectionDropInfoFromPoint(evt.clientX, evt.clientY);
    logCollectionDrag('pointer-move-hit', {
        x: evt.clientX,
        y: evt.clientY,
        dropInfo
    });
    if (!dropInfo?.folderId || !canDropCollectionRequest(activeCollectionPointerDrag.requestId, dropInfo)) {
        setCollectionPointerDropTarget(null);
        return;
    }
    setCollectionPointerDropTarget(dropInfo);
};

window.handleCollectionPointerUp = async function(evt, forceCancel = false) {
    if (!pendingCollectionPointerDrag && !activeCollectionPointerDrag) {
        setCollectionPointerCursorLock(false);
        return;
    }

    if (pendingCollectionPointerDrag) {
        logCollectionDrag('pointer-up-without-drag', {
            requestId: pendingCollectionPointerDrag.requestId
        });
        pendingCollectionPointerDrag = null;
        setCollectionPointerCursorLock(false);
        return;
    }

    const dragState = activeCollectionPointerDrag;
    const hoverInfo = pointerDragHoverInfo;
    const movingRequestId = dragState?.requestId ? String(dragState.requestId) : '';
    const canDrop = !forceCancel && !!hoverInfo?.folderId && !!movingRequestId && canDropCollectionRequest(movingRequestId, hoverInfo);

    if (dragState?.row) {
        dragState.row.classList.remove('dragging');
    }

    activeCollectionPointerDrag = null;
    pendingCollectionPointerDrag = null;
    draggingCollectionRequestState = null;
    document.documentElement.classList.remove('collection-pointer-dragging');
    document.body.classList.remove('collection-pointer-dragging');
    document.documentElement.style.cursor = '';
    document.body.style.cursor = '';
    setCollectionPointerCursorLock(false);
    setCollectionPointerDropTarget(null);

    if (!canDrop) {
        logCollectionDrag('pointer-drop-canceled', {
            forceCancel,
            movingRequestId,
            hoverInfo
        });
        return;
    }

    logCollectionDrag('pointer-drop', {
        movingRequestId,
        hoverInfo
    });
    await moveCollectionRequestToFolder(movingRequestId, hoverInfo);
    collectionPointerDragSuppressClickUntil = Date.now() + 220;

    if (evt?.preventDefault) {
        evt.preventDefault();
    }
};

function createCollectionActionButton(type, folderId, requestId = '') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tree-item-action-btn';
    btn.title = 'More actions';
    btn.innerHTML = getUiIconSvg('more-horizontal');
    btn.addEventListener('click', (evt) => {
        window.toggleCollectionItemMenu(type, folderId, requestId, evt);
    });
    return btn;
}

function collectionRequestMatchesKeyword(request, keyword) {
    const loweredKeyword = (keyword || '').trim().toLowerCase();
    if (!loweredKeyword) return true;
    const name = (request?.name || '').toLowerCase();
    const url = (request?.url || '').toLowerCase();
    const method = (request?.method || '').toLowerCase();
    return name.includes(loweredKeyword) || url.includes(loweredKeyword) || method.includes(loweredKeyword);
}

function buildCollectionsHierarchy(folders) {
    const normalized = normalizeCollectionsState(folders);
    const idSet = new Set(normalized.map((folder) => String(folder.id)));
    const roots = [];
    const childrenByParent = new Map();

    normalized.forEach((folder) => {
        const folderId = String(folder.id);
        let parentId = getCollectionFolderParentId(folder);
        if (parentId && (parentId === folderId || !idSet.has(parentId))) {
            parentId = null;
        }

        folder.parent_id = parentId;
        if (!parentId) {
            roots.push(folder);
            return;
        }

        if (!childrenByParent.has(parentId)) {
            childrenByParent.set(parentId, []);
        }
        childrenByParent.get(parentId).push(folder);
    });

    if (roots.length === 0 && normalized.length > 0) {
        childrenByParent.clear();
        normalized.forEach((folder) => {
            folder.parent_id = null;
            roots.push(folder);
        });
    }

    return {
        normalized,
        roots,
        childrenByParent
    };
}

function buildVisibleCollectionFolderIds(roots, childrenByParent, keyword) {
    const loweredKeyword = (keyword || '').trim().toLowerCase();
    const visibleIds = new Set();

    const visit = (folder, ancestorIds = new Set()) => {
        const folderId = String(folder.id);
        if (ancestorIds.has(folderId)) {
            return false;
        }

        const nextAncestors = new Set(ancestorIds);
        nextAncestors.add(folderId);

        const childFolders = childrenByParent.get(folderId) || [];
        const hasVisibleDescendant = childFolders.some((child) => visit(child, nextAncestors));
        const ownRequests = Array.isArray(folder.children) ? folder.children : [];
        const hasVisibleRequest = loweredKeyword
            ? ownRequests.some((request) => collectionRequestMatchesKeyword(request, loweredKeyword))
            : true;
        const isFolderMatch = loweredKeyword
            ? (folder.name || '').toLowerCase().includes(loweredKeyword)
            : true;
        const visible = loweredKeyword
            ? (isFolderMatch || hasVisibleRequest || hasVisibleDescendant)
            : true;

        if (visible) {
            visibleIds.add(folderId);
        }
        return visible;
    };

    roots.forEach((folder) => {
        visit(folder);
    });

    return visibleIds;
}

function renderCollectionFolderNode(folder, depth, keyword, visibleFolderIds, childrenByParent) {
    const folderId = String(folder.id);
    if (keyword && !visibleFolderIds.has(folderId)) {
        return null;
    }

    const isCollapsed = collapsedCollectionFolderIds.has(folderId);
    const folderGroup = document.createElement('div');

    const folderRow = document.createElement('div');
    folderRow.className = `tree-item tree-folder ${isCollapsed ? 'collapsed' : ''}`;
    folderRow.dataset.folderId = folderId;
    if (depth > 0) {
        folderRow.style.paddingLeft = `${10 + depth * 14}px`;
    }
    folderRow.addEventListener('click', () => {
        window.toggleFolder(folderRow);
    });
    folderRow.addEventListener('dragover', (evt) => window.handleCollectionFolderDragOver(folderId, evt));
    folderRow.addEventListener('dragleave', (evt) => window.handleCollectionFolderDragLeave(evt));
    folderRow.addEventListener('drop', (evt) => window.handleCollectionFolderDrop(folderId, evt));

    const chevron = document.createElement('span');
    chevron.className = 'icon icon-chevron';
    chevron.innerHTML = getUiIconSvg('chevron-down');

    const label = document.createElement('span');
    label.className = 'tree-folder-label';
    const folderIcon = document.createElement('span');
    folderIcon.className = 'icon icon-folder';
    folderIcon.innerHTML = getUiIconSvg('folder');
    const name = document.createElement('span');
    name.className = 'tree-folder-name';
    name.textContent = folder.name || 'Untitled folder';
    label.appendChild(folderIcon);
    label.appendChild(name);

    folderRow.appendChild(chevron);
    folderRow.appendChild(label);
    folderRow.appendChild(createCollectionActionButton('folder', folderId, ''));

    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'tree-children';
    childrenWrap.dataset.folderId = folderId;
    if (isCollapsed) {
        childrenWrap.style.display = 'none';
    }
    childrenWrap.addEventListener('dragover', (evt) => window.handleCollectionFolderDragOver(folderId, evt));
    childrenWrap.addEventListener('dragleave', (evt) => window.handleCollectionFolderDragLeave(evt));
    childrenWrap.addEventListener('drop', (evt) => window.handleCollectionFolderDrop(folderId, evt));

    const childFolders = childrenByParent.get(folderId) || [];
    childFolders.forEach((childFolder) => {
        const childNode = renderCollectionFolderNode(
            childFolder,
            depth + 1,
            keyword,
            visibleFolderIds,
            childrenByParent
        );
        if (childNode) {
            childrenWrap.appendChild(childNode);
        }
    });

    const children = Array.isArray(folder.children) ? folder.children : [];
    const visibleRequests = keyword
        ? children.filter((request) => collectionRequestMatchesKeyword(request, keyword))
        : children;

    visibleRequests.forEach((child) => {
        const childId = child?.id != null ? String(child.id) : generateCollectionEntityId('req');
        if (child && child.id == null) {
            child.id = childId;
        }
        const method = normalizeMethodValue(child?.method || 'GET');

        const requestRow = document.createElement('div');
        requestRow.className = 'tree-item tree-request is-draggable';
        requestRow.draggable = false;
        requestRow.dataset.folderId = folderId;
        requestRow.dataset.requestId = childId;
        if (depth > 0) {
            requestRow.style.paddingLeft = `${24 + depth * 14}px`;
        }
        if (window.PointerEvent) {
            requestRow.addEventListener('pointerdown', (evt) => {
                window.handleCollectionRequestPointerDown(childId, folderId, evt);
            });
        } else {
            requestRow.addEventListener('mousedown', (evt) => {
                window.handleCollectionRequestPointerDown(childId, folderId, evt);
            });
        }
        requestRow.addEventListener('click', (evt) => {
            if (Date.now() < collectionPointerDragSuppressClickUntil) {
                evt.preventDefault();
                evt.stopPropagation();
                return;
            }
        });
        requestRow.addEventListener('dblclick', (evt) => {
            if (Date.now() < collectionPointerDragSuppressClickUntil) {
                evt.preventDefault();
                evt.stopPropagation();
                return;
            }
            window.selectCollectionRequest(childId);
        });

        const badge = document.createElement('span');
        badge.className = `method-badge method-${method}`;
        badge.textContent = method;

        const text = document.createElement('span');
        text.className = 'tree-item-text';
        text.textContent = child?.name || child?.url || 'Untitled request';

        requestRow.appendChild(badge);
        requestRow.appendChild(text);
        requestRow.appendChild(createCollectionActionButton('request', folderId, childId));
        childrenWrap.appendChild(requestRow);
    });

    folderGroup.appendChild(folderRow);
    folderGroup.appendChild(childrenWrap);
    return folderGroup;
}

function renderCollections() {
    hideCollectionItemMenu();
    const panel = document.getElementById('collectionsContent');
    panel.innerHTML = '';

    const hierarchy = buildCollectionsHierarchy(collections);
    collections = hierarchy.normalized;
    const allFolderIds = new Set(collections.map((folder) => String(folder?.id)));
    collapsedCollectionFolderIds.forEach((id) => {
        if (!allFolderIds.has(id)) {
            collapsedCollectionFolderIds.delete(id);
        }
    });

    const keyword = collectionsSearchQuery.trim().toLowerCase();
    const visibleFolderIds = buildVisibleCollectionFolderIds(
        hierarchy.roots,
        hierarchy.childrenByParent,
        keyword
    );
    const visibleRoots = keyword
        ? hierarchy.roots.filter((folder) => visibleFolderIds.has(String(folder.id)))
        : hierarchy.roots;

    if (visibleRoots.length === 0) {
        panel.innerHTML = `
            <div class="empty-state" style="padding: 28px 20px;">
                <div class="empty-state-icon">${getUiIconSvg('search')}</div>
                <div>No collections matched</div>
            </div>
        `;
        return;
    }

    visibleRoots.forEach((folder) => {
        const node = renderCollectionFolderNode(
            folder,
            0,
            keyword,
            visibleFolderIds,
            hierarchy.childrenByParent
        );
        if (node) {
            panel.appendChild(node);
        }
    });
}

function generateCollectionFolderName(parentFolderId = null) {
    const base = 'collection';
    const normalizedParentId = parentFolderId != null ? String(parentFolderId) : null;
    const names = new Set(
        collections
            .filter((item) => {
                const itemParentId = getCollectionFolderParentId(item);
                if (normalizedParentId == null) {
                    return itemParentId == null;
                }
                return itemParentId === normalizedParentId;
            })
            .map((item) => String(item?.name || '').toLowerCase())
    );
    if (!names.has(base)) return base;

    let index = 2;
    while (names.has(`${base} ${index}`)) {
        index += 1;
    }
    return `${base} ${index}`;
}

window.filterCollections = function(query) {
    collectionsSearchQuery = query || '';
    renderCollections();
};

window.createCollectionFolder = async function(parentFolderId = null) {
    const normalizedParentId = parentFolderId != null ? String(parentFolderId) : null;
    if (normalizedParentId && !findCollectionFolderById(normalizedParentId)) {
        return;
    }

    const newFolder = {
        id: generateCollectionEntityId('folder'),
        name: generateCollectionFolderName(normalizedParentId),
        type: 'folder',
        parent_id: normalizedParentId,
        children: []
    };
    collections.push(newFolder);
    if (normalizedParentId) {
        collapsedCollectionFolderIds.delete(normalizedParentId);
    }
    renderCollections();
    if (await persistCollectionsState('create collection')) {
        showToast(normalizedParentId ? 'Folder created' : 'Top-level collection created');
    }
};

window.toggleFolder = function(element) {
    hideCollectionItemMenu();
    const children = element.nextElementSibling;
    const folderId = String(element?.dataset?.folderId || '');
    
    if (children && children.classList.contains('tree-children')) {
        if (children.style.display === 'none') {
            children.style.display = 'block';
            element.classList.remove('collapsed');
            if (folderId) collapsedCollectionFolderIds.delete(folderId);
        } else {
            children.style.display = 'none';
            element.classList.add('collapsed');
            if (folderId) collapsedCollectionFolderIds.add(folderId);
        }
    }
};

window.selectCollectionRequest = function(id) {
    hideCollectionItemMenu();
    const location = findCollectionRequestLocation(id);
    if (!location) return;

    const payload = getCollectionRequestPayload(location.request);
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
    const keyword = historySearchQuery.trim().toLowerCase();
    const filteredHistory = keyword
        ? history.filter((item) => {
            const method = String(item?.method || '').toLowerCase();
            const url = String(item?.url || '').toLowerCase();
            const date = formatDateGroup(item?.timestamp || '').toLowerCase();
            const time = formatTime(item?.timestamp || '').toLowerCase();
            return method.includes(keyword) || url.includes(keyword) || date.includes(keyword) || time.includes(keyword);
        })
        : history;
    
    if (filteredHistory.length === 0) {
        panel.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">${getUiIconSvg(keyword ? 'search' : 'clock')}</div>
                <div>${keyword ? 'No history matched' : 'No history yet'}</div>
            </div>
        `;
        return;
    }
    
    // 按日期分组
    const groups = {};
    filteredHistory.forEach(item => {
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
                     ondblclick="loadHistoryItem(${item.id})">
                    <span class="method-badge method-${item.method}">${item.method}</span>
                    <span class="url">${truncateUrl(item.url)}</span>
                    <span class="time">${formatTime(item.timestamp)}</span>
                </div>
            `).join('')}
        `;
        
        panel.appendChild(groupEl);
    });
}

window.filterHistory = function(query) {
    historySearchQuery = query || '';
    renderHistory();
};

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
        } else {
            const activeTab = getActiveTab();
            if (activeTab) {
                clearTabResponseState(activeTab);
                applyActiveTabResponseToUI();
            }
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
    const normalized = normalizeBodyFormatValue(format);
    if (!validFormats.includes(normalized)) {
        return;
    }

    currentBodyFormat = normalized;
    const bodyFormatSelect = document.getElementById('bodyFormatSelect');
    if (bodyFormatSelect && bodyFormatSelect.value !== normalized) {
        bodyFormatSelect.value = normalized;
    }
    syncBodyFormatPickerDisplay();

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
    if (currentResponseView !== 'body') {
        hideBodyFormatPicker();
    }

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

function updateMasterCheckboxState(tbodyId, masterCheckboxId) {
    const tbody = document.getElementById(tbodyId);
    const master = document.getElementById(masterCheckboxId);
    if (!tbody || !master) return;

    const rowChecks = Array.from(tbody.querySelectorAll('.param-checkbox'));
    const total = rowChecks.length;
    if (total === 0) {
        master.checked = false;
        master.indeterminate = false;
        return;
    }

    const checkedCount = rowChecks.filter((item) => item.checked).length;
    master.checked = checkedCount === total;
    master.indeterminate = checkedCount > 0 && checkedCount < total;
}

function updateParamsMasterCheckboxState() {
    updateMasterCheckboxState('queryParamsBody', 'queryParamsSelectAll');
}

function updateHeadersMasterCheckboxState() {
    updateMasterCheckboxState('headersBody', 'headersSelectAll');
}

window.toggleAllQueryParams = function(checked) {
    const tbody = document.getElementById('queryParamsBody');
    if (!tbody) return;
    tbody.querySelectorAll('.param-checkbox').forEach((checkbox) => {
        checkbox.checked = checked;
    });
    syncParamsToUrl();
    updateParamsMasterCheckboxState();
};

window.toggleAllHeaders = function(checked) {
    const tbody = document.getElementById('headersBody');
    if (!tbody) return;
    tbody.querySelectorAll('.param-checkbox').forEach((checkbox) => {
        checkbox.checked = checked;
    });
    updateBadges();
    updateHeadersMasterCheckboxState();
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
        updateParamsMasterCheckboxState();
    });
    
    updateBadges();
    updateParamsMasterCheckboxState();
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
    updateParamsMasterCheckboxState();
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
        updateHeadersMasterCheckboxState();
    });
    
    updateBadges();
    updateHeadersMasterCheckboxState();
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
    updateHeadersMasterCheckboxState();
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

    updateParamsMasterCheckboxState();
    updateHeadersMasterCheckboxState();
}

// ==================== 发送请求 ====================
window.sendRequest = async function() {
    const activeTab = getActiveTab();
    if (!activeTab) {
        showToast('Create a request tab first', 'error');
        return;
    }

    if (isSendingRequest) {
        window.cancelSendRequest(true);
        return;
    }

    const sendOperationId = startSendOperation();
    const requestTabId = activeTab.id;
    currentRequest = activeTab;

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
        const requestSnapshot = JSON.parse(JSON.stringify(currentRequest));
        
        const responseData = await invoke('send_http_request', { request: requestData });
        if (isSendOperationCanceled(sendOperationId)) {
            return;
        }
        
        // 显示响应
        displayResponse(responseData, {
            persistToActiveTab: true,
            targetTabId: requestTabId
        });
        
        // 保存到历史
        await saveToHistory(requestSnapshot, responseData);
        
    } catch (error) {
        if (isSendOperationCanceled(sendOperationId)) {
            return;
        }
        console.error('Request error:', error);
        const message = error?.message || String(error);
        const errorResponse = { body: message, headers: {}, body_base64: null };
        const targetTab = findRequestTabById(requestTabId);
        if (targetTab) {
            setTabResponseState(targetTab, errorResponse, { bodyFormat: 'raw', isError: true });
        }
        if (targetTab && targetTab.id === activeRequestTabId) {
            applyActiveTabResponseToUI();
            switchResponseView('body');
        }
    } finally {
        finishSendOperation(sendOperationId);
    }
};

// ==================== 显示响应 ====================
function displayResponse(data, options = {}) {
    const hasTargetTabId = typeof options.targetTabId === 'string' && options.targetTabId.length > 0;
    const targetTab = options.targetTabId
        ? findRequestTabById(options.targetTabId)
        : getActiveTab();

    if (hasTargetTabId && !targetTab) {
        return;
    }
    if (targetTab && options.persistToActiveTab !== false) {
        setTabResponseState(targetTab, data, {
            bodyFormat: inferResponseBodyFormat(data),
            isError: false
        });
    }

    const shouldUpdateUI = targetTab
        ? targetTab.id === activeRequestTabId
        : !hasTargetTabId;
    if (!shouldUpdateUI) {
        return;
    }

    latestResponseData = data;
    applyResponseStatusMeta(data, false);

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
                <div class="empty-state-icon">${getUiIconSvg('signal')}</div>
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
                <div class="empty-state-icon">${getUiIconSvg('warning')}</div>
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
                <div class="empty-state-icon">${getUiIconSvg('search')}</div>
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
                <div class="empty-state-icon">${getUiIconSvg('inbox')}</div>
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
                <div class="empty-state-icon">${getUiIconSvg('cookie')}</div>
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
    if (!getActiveTab()) {
        showToast('Create a request tab first', 'error');
        return;
    }
    syncCurrentRequestFromUI();
    openSaveRequestModal();
};

window.createNewFolder = function() {
    window.createCollectionFolder();
};

window.createNewRequest = function() {
    if (!getActiveTab()) {
        showToast('Create a request tab first', 'error');
        return;
    }
    syncCurrentRequestFromUI();
    openSaveRequestModal();
};

window.openSaveRequestModal = function() {
    syncCurrentRequestFromUI();
    const active = getActiveTab();
    if (!active) {
        showToast('Create a request tab first', 'error');
        return;
    }

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
    updateImportFileSelection(null);
    const fileInput = document.getElementById('importFileInput');
    if (fileInput) {
        fileInput.value = '';
    }
    document.getElementById('importTextarea').focus();
};

window.closeImportModal = function() {
    document.getElementById('importModal').classList.remove('active');
    updateImportFileSelection(null);
    const fileInput = document.getElementById('importFileInput');
    if (fileInput) {
        fileInput.value = '';
    }
};

function updateImportFileSelection(fileRecord) {
    selectedImportCollectionFile = fileRecord;
    const selectedNameEl = document.getElementById('importFileSelectedName');
    if (!selectedNameEl) return;
    selectedNameEl.textContent = fileRecord?.name || 'No file selected';
}

window.chooseImportCollectionFile = function() {
    const input = document.getElementById('importFileInput');
    if (!input) return;
    input.click();
};

window.handleImportCollectionFileChange = async function(evt) {
    const file = evt?.target?.files?.[0];
    if (!file) {
        updateImportFileSelection(null);
        return;
    }

    try {
        const text = await file.text();
        updateImportFileSelection({
            name: file.name || 'collection.json',
            content: text
        });
    } catch (error) {
        console.error('Read import file error:', error);
        updateImportFileSelection(null);
        showToast('Failed to read selected file', 'error');
    }
};

window.importCollectionFile = async function() {
    if (!selectedImportCollectionFile?.content) {
        showToast('Please choose a local Postman file first', 'error');
        return;
    }

    try {
        const imported = await invoke('import_collection_json', {
            jsonText: selectedImportCollectionFile.content,
            sourceName: selectedImportCollectionFile.name || 'Imported Collection'
        });
        collections = normalizeCollectionsState(Array.isArray(imported) ? imported : []);
        collectionsSearchQuery = '';
        const searchInput = document.getElementById('collectionsSearchInput');
        if (searchInput) {
            searchInput.value = '';
        }
        renderCollections();

        const sidebar = document.getElementById('sidebar');
        if (sidebar && (sidebar.classList.contains('collapsed') || sidebar.getBoundingClientRect().width < 8)) {
            sidebar.classList.remove('collapsed');
            sidebar.style.width = '280px';
            syncWorkspaceTopbarState();
        }
        document.getElementById('collectionsPanel').classList.remove('hidden');
        document.getElementById('historyPanel').classList.add('hidden');

        const collectionsBtn = document.querySelector('.icon-sidebar .icon-item[title="Collections"]');
        if (collectionsBtn) {
            document.querySelectorAll('.icon-sidebar .icon-item').forEach((item) => item.classList.remove('active'));
            collectionsBtn.classList.add('active');
        }

        closeImportModal();
        createNewRequestTab();
        showToast('Postman collection imported');
    } catch (error) {
        console.error('Import collection file error:', error);
        const message = error?.message || String(error);
        showToast(message || 'Import failed', 'error');
    }
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
    setMethodSelectValue(parsed.method || 'GET');
    syncMethodPickerDisplay();
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
    if (!active) {
        showToast('Create a request tab first', 'error');
        return;
    }

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
    const rightSidebarResizer = document.getElementById('rightSidebarResizer');
    const rightShell = document.getElementById('rightShell');
    const rightSidebarPanel = document.getElementById('rightSidebarPanel');
    const rightIconSidebar = document.getElementById('rightIconSidebar');
    let isResizingRightSidebar = false;
    const minRightSidebarWidth = 260;
    const maxRightSidebarWidth = 620;
    const rightCollapseThreshold = 120;
    
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
            syncWorkspaceTopbarState();
            return;
        }

        sidebar.classList.remove('collapsed');
        newWidth = Math.max(minSidebarWidth, Math.min(maxSidebarWidth, newWidth));
        sidebar.style.width = `${newWidth}px`;
        syncWorkspaceTopbarState();
    });

    if (rightSidebarResizer && rightShell && rightSidebarPanel && rightIconSidebar) {
        rightSidebarResizer.addEventListener('mousedown', (e) => {
            if (rightShell.classList.contains('collapsed') || rightSidebarPanel.getBoundingClientRect().width < 8) {
                return;
            }
            isResizingRightSidebar = true;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });
    }

    document.addEventListener('mousemove', (e) => {
        if (!isResizingRightSidebar || !rightShell || !rightSidebarPanel || !rightIconSidebar) return;

        const iconWidth = rightIconSidebar.getBoundingClientRect().width;
        let newWidth = window.innerWidth - e.clientX - iconWidth;

        if (newWidth <= rightCollapseThreshold) {
            rightShell.classList.add('collapsed');
            rightSidebarPanel.style.width = '0px';
            syncRightSidebarState();
            return;
        }

        rightShell.classList.remove('collapsed');
        newWidth = Math.max(minRightSidebarWidth, Math.min(maxRightSidebarWidth, newWidth));
        rightSidebarPanel.style.width = `${Math.round(newWidth)}px`;
        syncRightSidebarState();
    });
    
    document.addEventListener('mouseup', () => {
        isResizingSidebar = false;
        isResizingRightSidebar = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        syncWorkspaceTopbarState();
        syncRightSidebarState();
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
    let minResponseHeight = 150;
    let panelTotalHeight = 0;

    function getRequestBuilderMinHeight() {
        const urlBar = requestBuilder.querySelector('.url-bar-container');
        const tabs = requestBuilder.querySelector('.tabs');
        const fixedHeight = (urlBar?.offsetHeight || 0) + (tabs?.offsetHeight || 0);
        return Math.max(96, fixedHeight + 4);
    }

    function getResponsePanelMinHeight() {
        const computed = window.getComputedStyle(responsePanel);
        const cssMinHeight = parseFloat(computed.minHeight) || 0;
        return Math.max(150, Math.round(cssMinHeight));
    }

    function clampPanelHeights(nextRequestHeight) {
        const maxRequestHeight = Math.max(minRequestHeight, panelTotalHeight - minResponseHeight);
        const requestHeight = Math.min(Math.max(nextRequestHeight, minRequestHeight), maxRequestHeight);
        const responseHeight = Math.max(minResponseHeight, panelTotalHeight - requestHeight);
        return { requestHeight, responseHeight };
    }

    function applyPanelHeights(requestHeight, responseHeight) {
        requestBuilder.style.flex = 'none';
        requestBuilder.style.height = `${Math.round(requestHeight)}px`;
        responsePanel.style.flex = 'none';
        responsePanel.style.height = `${Math.round(responseHeight)}px`;
    }
    
    panelResizer.addEventListener('mousedown', (e) => {
        isResizingPanel = true;
        panelStartY = e.clientY;
        requestStartHeight = requestBuilder.getBoundingClientRect().height;
        responseStartHeight = responsePanel.getBoundingClientRect().height;
        minRequestHeight = getRequestBuilderMinHeight();
        minResponseHeight = getResponsePanelMinHeight();
        panelTotalHeight = requestStartHeight + responseStartHeight;
        const requiredMinTotal = minRequestHeight + minResponseHeight;
        if (panelTotalHeight < requiredMinTotal) {
            panelTotalHeight = requiredMinTotal;
        }
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isResizingPanel) return;

        const deltaY = e.clientY - panelStartY;
        const { requestHeight, responseHeight } = clampPanelHeights(requestStartHeight + deltaY);
        applyPanelHeights(requestHeight, responseHeight);
    });
    
    function stopPanelResize() {
        isResizingPanel = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    }

    document.addEventListener('mouseup', stopPanelResize);
    window.addEventListener('mouseup', stopPanelResize);
    window.addEventListener('blur', stopPanelResize);

    window.addEventListener('resize', () => {
        if (!requestBuilder.style.height || !responsePanel.style.height) return;
        minRequestHeight = getRequestBuilderMinHeight();
        minResponseHeight = getResponsePanelMinHeight();
        panelTotalHeight = requestBuilder.getBoundingClientRect().height + responsePanel.getBoundingClientRect().height;
        const requiredMinTotal = minRequestHeight + minResponseHeight;
        if (panelTotalHeight < requiredMinTotal) {
            panelTotalHeight = requiredMinTotal;
        }
        const { requestHeight, responseHeight } = clampPanelHeights(requestBuilder.getBoundingClientRect().height);
        applyPanelHeights(requestHeight, responseHeight);
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
    const methodMatch = normalized.match(/(?:^|\s)(?:-X|--request)(?:\s+|=)([A-Za-z]+)/i)
        || normalized.match(/(?:^|\s)-X([A-Za-z]+)/i);
    const explicitMethod = methodMatch ? methodMatch[1].toUpperCase() : '';
    const hasHeadFlag = /(?:^|\s)(?:--head|-I)(?:\s|$)/i.test(normalized);
    const hasGetFlag = /(?:^|\s)(?:--get|-G)(?:\s|$)/i.test(normalized);
    const hasUploadFlag = /(?:^|\s)(?:--upload-file|-T)(?:\s|=|$)/i.test(normalized);
    const hasDataFlag = /(?:^|\s)(?:--data(?:-raw|-binary|-urlencode)?|-d|--form|-F)(?:\s|=|$)/i.test(normalized);

    let method = 'GET';
    if (explicitMethod) {
        method = explicitMethod;
    } else if (hasHeadFlag) {
        method = 'HEAD';
    } else if (hasGetFlag) {
        method = 'GET';
    } else if (hasUploadFlag) {
        method = 'PUT';
    } else if (hasDataFlag) {
        method = 'POST';
    }

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
