// SAM 抠图应用 - 前端逻辑 (Tauri 2.0)

// 全局状态
const state = {
    modelLoaded: false,
    currentImage: null,
    currentResult: null,
    interactivePoints: [],
    interactiveLabels: [],
    zoom: 1,
    autoSegmentationOptions: {
        method: 'center_point',
        selectMode: 'best_score',
        pointsPerSide: 32,
        predIouThresh: 0.86,
        stabilityScoreThresh: 0.92,
        minMaskRegionArea: 120,
        smoothRadius: 1.2,
        alphaThreshold: 12,
    },
    interactiveOptions: {
        selectMode: 'best_score',
        smoothRadius: 0.6,
        alphaThreshold: 6,
        localZoom: 1.8,
    },
    interactiveView: {
        offsetX: 0,
        offsetY: 0,
        isDragging: false,
        pointerId: null,
        startClientX: 0,
        startClientY: 0,
        startOffsetX: 0,
        startOffsetY: 0,
        pendingLabel: 1,
    },
    interactiveEditor: {
        open: false,
    },
    singlePreviewViewer: {
        open: false,
        activeType: 'original',
        zoom: 1,
        minZoom: 0.2,
        maxZoom: 8,
        offsetX: 0,
        offsetY: 0,
        isDragging: false,
        dragStartX: 0,
        dragStartY: 0,
        dragStartOffsetX: 0,
        dragStartOffsetY: 0,
        externalOriginalSrc: '',
        externalResultSrc: '',
    },
    taskSeq: 0,
    taskMaxParallel: 1,
    taskRunningCount: 0,
    tasks: [],
};

const TASK_MAX_PARALLEL_STORAGE_KEY = 'sam_task_max_parallel';
const INTERACTIVE_PAN_DRAG_THRESHOLD = 6;

// DOM 元素
const elements = {};
const SAM_BRIDGE_MESSAGE_FLAG = '__SAM_TAURI_BRIDGE_MESSAGE__';
const SAM_BRIDGE_TIMEOUT_MS = 3000;
let samBridgeRequestSeq = 0;
let samBridgeMessageListenerBound = false;
const samBridgePendingRequests = new Map();
const samBridgeEventHandlers = new Map();
let samNoticeTimer = null;

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
    // 等待 Tauri API 加载
    await initTauri();
    initElements();
    initTabs();
    initSingleMode();
    initInteractiveMode();
    initBatchMode();
    initSettings();
    initTaskModule();
    checkSamModelLoaded();
});

// 初始化 Tauri API
async function initTauri() {
    const applyBridge = (bridge) => {
        window.tauriCore = bridge?.core || null;
        window.tauriDialog = bridge?.dialog || null;
        window.tauriEvent = bridge?.event || null;
    };

    const directBridge = resolveDirectBridge();
    if (directBridge?.core) {
        const tauriApi = resolveDirectTauriApi();
        applyBridge({
            core: directBridge.core,
            dialog: directBridge.dialog || tauriApi?.dialog || null,
            event: directBridge.event || tauriApi?.event || null
        });
        if (window.tauriDialog) {
            return;
        }

        const bridgeWithDialog = await tryCreatePostMessageBridge();
        if (bridgeWithDialog?.dialog || bridgeWithDialog?.event) {
            applyBridge({
                core: directBridge.core,
                dialog: window.tauriDialog || bridgeWithDialog.dialog || null,
                event: window.tauriEvent || bridgeWithDialog.event || null
            });
        }
        return;
    }

    const postMessageBridge = await tryCreatePostMessageBridge();
    if (postMessageBridge?.core) {
        applyBridge(postMessageBridge);
        return;
    }

    let retries = 0;
    while (retries < 50) {
        const bridge = resolveDirectBridge();
        if (bridge?.core) {
            applyBridge(bridge);
            return;
        }

        const tauriApi = resolveDirectTauriApi();
        if (tauriApi?.core) {
            applyBridge({
                core: tauriApi.core,
                dialog: tauriApi.dialog || null,
                event: tauriApi.event || null
            });
            return;
        }

        await new Promise(resolve => setTimeout(resolve, 100));
        retries++;
    }

    console.error('Tauri API not available after 5 seconds');
}

function resolveDirectBridge() {
    if (window.__SAM_TAURI_BRIDGE__) {
        return window.__SAM_TAURI_BRIDGE__;
    }

    try {
        return window.parent?.__SAM_TAURI_BRIDGE__ || null;
    } catch (error) {
        return null;
    }
}

function resolveDirectTauriApi() {
    if (window.__TAURI__) {
        return window.__TAURI__;
    }

    try {
        return window.parent?.__TAURI__ || null;
    } catch (error) {
        return null;
    }
}

function canUseParentBridge() {
    return !!(window.parent && window.parent !== window);
}

function onSamBridgeMessage(event) {
    const data = event?.data;
    if (!data || data[SAM_BRIDGE_MESSAGE_FLAG] !== true) {
        return;
    }

    if (data.direction === 'response') {
        const pending = samBridgePendingRequests.get(data.requestId);
        if (!pending) return;
        samBridgePendingRequests.delete(data.requestId);
        clearTimeout(pending.timeoutId);
        if (data.ok) {
            pending.resolve(data.result);
        } else {
            pending.reject(new Error(data.error || 'Bridge request failed'));
        }
        return;
    }

    if (data.direction === 'event') {
        const listenerId = typeof data.listenerId === 'string' ? data.listenerId : '';
        if (!listenerId) return;
        const handler = samBridgeEventHandlers.get(listenerId);
        if (!handler) return;
        try {
            handler({ payload: data.payload });
        } catch (error) {
            console.error('Bridge event handler failed:', error);
        }
    }
}

function ensureSamBridgeMessageListener() {
    if (samBridgeMessageListenerBound) return;
    window.addEventListener('message', onSamBridgeMessage);
    samBridgeMessageListenerBound = true;
}

function sendSamBridgeRequest(action, payload = {}, timeoutMs = SAM_BRIDGE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        if (!canUseParentBridge()) {
            reject(new Error('Parent bridge not available'));
            return;
        }

        ensureSamBridgeMessageListener();
        const requestId = `sam-bridge-${Date.now()}-${++samBridgeRequestSeq}`;
        const timeoutId = setTimeout(() => {
            samBridgePendingRequests.delete(requestId);
            reject(new Error(`Bridge request timeout: ${action}`));
        }, timeoutMs);

        samBridgePendingRequests.set(requestId, { resolve, reject, timeoutId });
        window.parent.postMessage({
            [SAM_BRIDGE_MESSAGE_FLAG]: true,
            direction: 'request',
            requestId,
            action,
            payload
        }, '*');
    });
}

async function tryCreatePostMessageBridge() {
    if (!canUseParentBridge()) {
        return null;
    }

    try {
        const pingResult = await sendSamBridgeRequest('ping', {}, 1200);
        return {
            core: {
                invoke: async (cmd, args = {}) => sendSamBridgeRequest('invoke', { cmd, args }),
                convertFileSrc: async (path) => sendSamBridgeRequest('convert-file-src', { path })
            },
            dialog: pingResult?.hasDialog ? {
                open: async (options = {}) => sendSamBridgeRequest('dialog-open', { options }),
                save: async (options = {}) => sendSamBridgeRequest('dialog-save', { options })
            } : null,
            event: {
                listen: async (eventName, callback) => {
                    const response = await sendSamBridgeRequest('listen', { eventName });
                    const listenerId = response?.listenerId;
                    if (!listenerId) {
                        throw new Error('Failed to create event listener');
                    }
                    samBridgeEventHandlers.set(listenerId, callback);
                    return async () => {
                        samBridgeEventHandlers.delete(listenerId);
                        try {
                            await sendSamBridgeRequest('unlisten', { listenerId });
                        } catch (error) {
                            console.warn('Failed to unlisten bridge event:', error);
                        }
                    };
                }
            }
        };
    } catch (error) {
        return null;
    }
}

// invoke 包装函数
async function invoke(cmd, args = {}) {
    if (!window.tauriCore) {
        console.error('Tauri core not available');
        throw new Error('Tauri core not available');
    }
    return await window.tauriCore.invoke(cmd, args);
}

// dialog.open 包装函数
async function open(options = {}) {
    if (!window.tauriDialog) {
        console.error('Tauri dialog not available');
        throw new Error('Tauri dialog not available');
    }
    return await window.tauriDialog.open(options);
}

// dialog.save 包装函数
async function save(options = {}) {
    if (!window.tauriDialog) {
        console.error('Tauri dialog not available');
        throw new Error('Tauri dialog not available');
    }
    return await window.tauriDialog.save(options);
}

// 初始化 DOM 元素引用
function initElements() {
    // Tab 按钮
    elements.tabBtns = document.querySelectorAll('.tab-btn');
    elements.tabContents = document.querySelectorAll('.tab-content');
    
    // 单张模式
    elements.singleUpload = document.getElementById('single-upload');
    elements.singleFile = document.getElementById('single-file');
    elements.singlePreview = document.getElementById('single-preview');
    elements.singleOriginal = document.getElementById('single-original');
    elements.singleResult = document.getElementById('single-result');
    elements.singleProcess = document.getElementById('single-process');
    elements.singleSave = document.getElementById('single-save');
    elements.singleClear = document.getElementById('single-clear');
    elements.singleAutoMethod = document.getElementById('single-auto-method');
    elements.singleSelectMode = document.getElementById('single-select-mode');
    elements.singlePointsPerSide = document.getElementById('single-points-per-side');
    elements.singlePointsPerSideValue = document.getElementById('single-points-per-side-value');
    elements.singlePredIou = document.getElementById('single-pred-iou');
    elements.singlePredIouValue = document.getElementById('single-pred-iou-value');
    elements.singleStability = document.getElementById('single-stability');
    elements.singleStabilityValue = document.getElementById('single-stability-value');
    elements.singleMinMaskArea = document.getElementById('single-min-mask-area');
    elements.singleSmoothRadius = document.getElementById('single-smooth-radius');
    elements.singleSmoothRadiusValue = document.getElementById('single-smooth-radius-value');
    elements.singleAlphaThreshold = document.getElementById('single-alpha-threshold');
    elements.singleAlphaThresholdValue = document.getElementById('single-alpha-threshold-value');
    elements.singleGeneratorOnlyGroups = document.querySelectorAll('.single-options .generator-only');
    elements.imagePreviewModal = document.getElementById('imagePreviewModal');
    elements.imagePreviewStage = document.getElementById('imagePreviewStage');
    elements.imagePreviewImage = document.getElementById('imagePreviewImage');
    elements.previewTabOriginal = document.getElementById('previewTabOriginal');
    elements.previewTabResult = document.getElementById('previewTabResult');
    elements.previewZoomOut = document.getElementById('previewZoomOut');
    elements.previewZoomIn = document.getElementById('previewZoomIn');
    elements.previewZoomReset = document.getElementById('previewZoomReset');
    elements.previewZoomValue = document.getElementById('previewZoomValue');
    elements.previewCloseBtn = document.getElementById('previewCloseBtn');
    
    // 交互式模式
    elements.interactiveUpload = document.getElementById('interactive-upload');
    elements.interactiveFile = document.getElementById('interactive-file');
    elements.interactivePreview = document.getElementById('interactive-preview');
    elements.interactiveCanvas = document.getElementById('interactive-canvas');
    elements.interactiveCanvasContainer = elements.interactiveCanvas?.closest('.canvas-container') || null;
    elements.interactiveCanvasHost = document.getElementById('interactive-canvas-host');
    elements.interactiveOpenPreview = document.getElementById('interactive-open-preview');
    elements.interactiveEditorModal = document.getElementById('interactiveEditorModal');
    elements.interactiveEditorStage = document.getElementById('interactiveEditorStage');
    elements.interactiveEditorCloseBtn = document.getElementById('interactiveEditorCloseBtn');
    elements.interactiveProcess = document.getElementById('interactive-process');
    elements.interactiveSave = document.getElementById('interactive-save');
    elements.interactiveSelectMode = document.getElementById('interactive-select-mode');
    elements.interactiveSmoothRadius = document.getElementById('interactive-smooth-radius');
    elements.interactiveSmoothRadiusValue = document.getElementById('interactive-smooth-radius-value');
    elements.interactiveAlphaThreshold = document.getElementById('interactive-alpha-threshold');
    elements.interactiveAlphaThresholdValue = document.getElementById('interactive-alpha-threshold-value');
    elements.interactiveLocalZoom = document.getElementById('interactive-local-zoom');
    elements.interactiveLocalZoomValue = document.getElementById('interactive-local-zoom-value');
    elements.toolUndo = document.getElementById('tool-undo');
    elements.toolClear = document.getElementById('tool-clear');
    elements.zoomIn = document.getElementById('zoom-in');
    elements.zoomOut = document.getElementById('zoom-out');
    elements.zoomLevel = document.getElementById('zoom-level');
    
    // 批量模式
    elements.batchInput = document.getElementById('batch-input');
    elements.batchOutput = document.getElementById('batch-output');
    elements.batchInputBtn = document.getElementById('batch-input-btn');
    elements.batchOutputBtn = document.getElementById('batch-output-btn');
    elements.batchStart = document.getElementById('batch-start');
    elements.batchProgress = document.getElementById('batch-progress');
    elements.progressFill = document.getElementById('progress-fill');
    elements.progressText = document.getElementById('progress-text');
    elements.progressPercent = document.getElementById('progress-percent');
    elements.progressLog = document.getElementById('progress-log');
    elements.batchResults = document.getElementById('batch-results');
    elements.resultsGrid = document.getElementById('results-grid');

    // 任务列表
    elements.taskList = document.getElementById('task-list');
    elements.taskEmpty = document.getElementById('task-empty');
    elements.taskCount = document.getElementById('task-count');
    elements.taskRunningCount = document.getElementById('task-running-count');
    elements.taskQueuedCount = document.getElementById('task-queued-count');
    elements.taskClearFinished = document.getElementById('task-clear-finished');
    
    // 设置
    elements.modelPath = document.getElementById('model-path');
    elements.modelPathBtn = document.getElementById('model-path-btn');
    elements.modelLoad = document.getElementById('model-load');
    elements.modelStatus = document.getElementById('model-status');
    elements.pythonPath = document.getElementById('python-path');
    elements.pythonPathBtn = document.getElementById('python-path-btn');
    elements.pythonPathSave = document.getElementById('python-path-save');
    elements.pythonDepsCheck = document.getElementById('python-deps-check');
    elements.pythonDepsResult = document.getElementById('python-deps-result');
    elements.taskMaxParallel = document.getElementById('task-max-parallel');
    elements.outputFormat = document.getElementById('output-format');
    elements.outputQuality = document.getElementById('output-quality');
    elements.qualityValue = document.getElementById('quality-value');
    elements.loadingOverlay = document.getElementById('loading-overlay');
    elements.loadingText = document.getElementById('loading-text');
    
    // 代理设置
    elements.proxyEnabled = document.getElementById('proxy-enabled');
    elements.proxyUrl = document.getElementById('proxy-url');
    elements.proxyUsername = document.getElementById('proxy-username');
    elements.proxyPassword = document.getElementById('proxy-password');
    elements.proxyTest = document.getElementById('proxy-test');
    elements.proxySave = document.getElementById('proxy-save');
    elements.proxyTestResult = document.getElementById('proxy-test-result');
}

// 初始化标签页
function initTabs() {
    elements.tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.dataset.tab;
            activateTab(tabId);
        });
    });
}

function activateTab(tabId) {
    if (!tabId) return;
    elements.tabBtns?.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    elements.tabContents?.forEach((content) => {
        content.classList.toggle('active', content.id === tabId);
    });
}

function ensureSamNoticeElement() {
    let notice = document.getElementById('samGlobalNotice');
    if (notice) return notice;

    notice = document.createElement('div');
    notice.id = 'samGlobalNotice';
    notice.style.position = 'fixed';
    notice.style.right = '16px';
    notice.style.top = '16px';
    notice.style.maxWidth = '420px';
    notice.style.padding = '10px 12px';
    notice.style.borderRadius = '8px';
    notice.style.fontSize = '13px';
    notice.style.lineHeight = '1.5';
    notice.style.boxShadow = '0 8px 18px rgba(15, 23, 42, 0.2)';
    notice.style.border = '1px solid #f2cd6f';
    notice.style.background = '#fff8e1';
    notice.style.color = '#7a5200';
    notice.style.zIndex = '1600';
    notice.style.display = 'none';
    document.body.appendChild(notice);
    return notice;
}

function showSamNotice(message, type = 'warn', duration = 3600) {
    const notice = ensureSamNoticeElement();
    const styles = type === 'error'
        ? {
            border: '#efb4b8',
            bg: '#fff4f5',
            color: '#8f1d2c'
        }
        : type === 'success'
            ? {
                border: '#a6dfbf',
                bg: '#edfdf3',
                color: '#09613a'
            }
            : {
                border: '#f2cd6f',
                bg: '#fff8e1',
                color: '#7a5200'
            };

    notice.style.borderColor = styles.border;
    notice.style.background = styles.bg;
    notice.style.color = styles.color;
    notice.textContent = message;
    notice.style.display = 'block';

    if (samNoticeTimer) {
        clearTimeout(samNoticeTimer);
        samNoticeTimer = null;
    }

    if (duration > 0) {
        samNoticeTimer = setTimeout(() => {
            notice.style.display = 'none';
            samNoticeTimer = null;
        }, duration);
    }
}

async function ensureModelReady(actionLabel = '当前操作') {
    try {
        const loaded = await invoke('is_model_loaded');
        state.modelLoaded = !!loaded;
        updateModelStatus(state.modelLoaded);
    } catch (error) {
        state.modelLoaded = false;
        updateModelStatus(false);
    }

    if (state.modelLoaded) {
        return true;
    }

    showSamNotice(`模型未加载，无法执行${actionLabel}。请先到“设置”页加载 SAM 模型。`, 'warn', 4800);
    activateTab('settings');
    return false;
}

function setTextContent(el, text) {
    if (el) {
        el.textContent = text;
    }
}

function toClampedInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function toClampedFloat(value, fallback, min, max) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function syncSingleAutoOptionLabels() {
    setTextContent(elements.singlePointsPerSideValue, String(state.autoSegmentationOptions.pointsPerSide));
    setTextContent(elements.singlePredIouValue, state.autoSegmentationOptions.predIouThresh.toFixed(2));
    setTextContent(elements.singleStabilityValue, state.autoSegmentationOptions.stabilityScoreThresh.toFixed(2));
    setTextContent(elements.singleSmoothRadiusValue, state.autoSegmentationOptions.smoothRadius.toFixed(1));
    setTextContent(elements.singleAlphaThresholdValue, String(state.autoSegmentationOptions.alphaThreshold));
}

function syncSingleAutoMethodVisibility() {
    const isGenerator = state.autoSegmentationOptions.method === 'auto_generator';
    elements.singleGeneratorOnlyGroups?.forEach((group) => {
        group.style.display = isGenerator ? '' : 'none';
    });
}

function syncSingleAutoControlsFromState() {
    if (!elements.singleAutoMethod) return;
    elements.singleAutoMethod.value = state.autoSegmentationOptions.method;
    elements.singleSelectMode.value = state.autoSegmentationOptions.selectMode;
    elements.singlePointsPerSide.value = String(state.autoSegmentationOptions.pointsPerSide);
    elements.singlePredIou.value = String(state.autoSegmentationOptions.predIouThresh);
    elements.singleStability.value = String(state.autoSegmentationOptions.stabilityScoreThresh);
    elements.singleMinMaskArea.value = String(state.autoSegmentationOptions.minMaskRegionArea);
    elements.singleSmoothRadius.value = String(state.autoSegmentationOptions.smoothRadius);
    elements.singleAlphaThreshold.value = String(state.autoSegmentationOptions.alphaThreshold);
    syncSingleAutoOptionLabels();
    syncSingleAutoMethodVisibility();
}

function readSingleAutoOptionsFromControls() {
    if (!elements.singleAutoMethod) {
        return;
    }

    state.autoSegmentationOptions.method =
        elements.singleAutoMethod.value === 'auto_generator' ? 'auto_generator' : 'center_point';
    state.autoSegmentationOptions.selectMode =
        elements.singleSelectMode.value === 'largest_area' ? 'largest_area' : 'best_score';
    state.autoSegmentationOptions.pointsPerSide = toClampedInt(elements.singlePointsPerSide.value, 32, 8, 96);
    state.autoSegmentationOptions.predIouThresh = toClampedFloat(elements.singlePredIou.value, 0.86, 0.10, 0.99);
    state.autoSegmentationOptions.stabilityScoreThresh = toClampedFloat(elements.singleStability.value, 0.92, 0.10, 0.99);
    state.autoSegmentationOptions.minMaskRegionArea = toClampedInt(elements.singleMinMaskArea.value, 120, 0, 100000);
    state.autoSegmentationOptions.smoothRadius = toClampedFloat(elements.singleSmoothRadius.value, 1.2, 0, 12);
    state.autoSegmentationOptions.alphaThreshold = toClampedInt(elements.singleAlphaThreshold.value, 12, 0, 200);

    syncSingleAutoOptionLabels();
    syncSingleAutoMethodVisibility();
}

function getSingleAutoOptionsPayload() {
    readSingleAutoOptionsFromControls();
    return {
        method: state.autoSegmentationOptions.method,
        select_mode: state.autoSegmentationOptions.selectMode,
        points_per_side: state.autoSegmentationOptions.pointsPerSide,
        pred_iou_thresh: state.autoSegmentationOptions.predIouThresh,
        stability_score_thresh: state.autoSegmentationOptions.stabilityScoreThresh,
        min_mask_region_area: state.autoSegmentationOptions.minMaskRegionArea,
        smooth_radius: state.autoSegmentationOptions.smoothRadius,
        alpha_threshold: state.autoSegmentationOptions.alphaThreshold,
    };
}

function initSingleOptionsControls() {
    if (!elements.singleAutoMethod) return;
    syncSingleAutoControlsFromState();

    [
        elements.singleAutoMethod,
        elements.singleSelectMode,
        elements.singlePointsPerSide,
        elements.singlePredIou,
        elements.singleStability,
        elements.singleMinMaskArea,
        elements.singleSmoothRadius,
        elements.singleAlphaThreshold,
    ].forEach((control) => {
        if (!control) return;
        const eventName = control.tagName === 'SELECT' ? 'change' : 'input';
        control.addEventListener(eventName, () => {
            readSingleAutoOptionsFromControls();
        });
        if (eventName !== 'change') {
            control.addEventListener('change', () => {
                readSingleAutoOptionsFromControls();
            });
        }
    });
}

function syncInteractiveOptionLabels() {
    setTextContent(
        elements.interactiveSmoothRadiusValue,
        state.interactiveOptions.smoothRadius.toFixed(1)
    );
    setTextContent(
        elements.interactiveAlphaThresholdValue,
        String(state.interactiveOptions.alphaThreshold)
    );
    setTextContent(
        elements.interactiveLocalZoomValue,
        `${Math.round(state.interactiveOptions.localZoom * 100)}%`
    );
}

function syncInteractiveControlsFromState() {
    if (!elements.interactiveSelectMode) return;
    elements.interactiveSelectMode.value = state.interactiveOptions.selectMode;
    elements.interactiveSmoothRadius.value = String(state.interactiveOptions.smoothRadius);
    elements.interactiveAlphaThreshold.value = String(state.interactiveOptions.alphaThreshold);
    elements.interactiveLocalZoom.value = String(state.interactiveOptions.localZoom);
    syncInteractiveOptionLabels();
}

function readInteractiveOptionsFromControls() {
    if (!elements.interactiveSelectMode) return;
    const selectMode = elements.interactiveSelectMode.value;
    state.interactiveOptions.selectMode =
        selectMode === 'largest_area' || selectMode === 'smallest_area'
            ? selectMode
            : 'best_score';
    state.interactiveOptions.smoothRadius = toClampedFloat(
        elements.interactiveSmoothRadius.value,
        0.6,
        0,
        12
    );
    state.interactiveOptions.alphaThreshold = toClampedInt(
        elements.interactiveAlphaThreshold.value,
        6,
        0,
        200
    );
    state.interactiveOptions.localZoom = toClampedFloat(
        elements.interactiveLocalZoom.value,
        1.8,
        1,
        4
    );
    syncInteractiveOptionLabels();
}

function getInteractiveOptionsPayload() {
    readInteractiveOptionsFromControls();
    return {
        select_mode: state.interactiveOptions.selectMode,
        smooth_radius: state.interactiveOptions.smoothRadius,
        alpha_threshold: state.interactiveOptions.alphaThreshold,
    };
}

function initInteractiveOptionsControls() {
    if (!elements.interactiveSelectMode) return;
    syncInteractiveControlsFromState();
    [
        elements.interactiveSelectMode,
        elements.interactiveSmoothRadius,
        elements.interactiveAlphaThreshold,
        elements.interactiveLocalZoom,
    ].forEach((control) => {
        if (!control) return;
        const eventName = control.tagName === 'SELECT' ? 'change' : 'input';
        control.addEventListener(eventName, () => {
            readInteractiveOptionsFromControls();
            if (control === elements.interactiveLocalZoom && state.currentImage) {
                state.zoom = state.interactiveOptions.localZoom;
                updateZoom();
            }
        });
        if (eventName !== 'change') {
            control.addEventListener('change', () => {
                readInteractiveOptionsFromControls();
                if (control === elements.interactiveLocalZoom && state.currentImage) {
                    state.zoom = state.interactiveOptions.localZoom;
                    updateZoom();
                }
            });
        }
    });
}

function setInteractiveCanvasDragging(isDragging) {
    if (!elements.interactiveCanvasContainer) return;
    elements.interactiveCanvasContainer.classList.toggle('dragging', !!isDragging);
}

function getCanvasPointFromEvent(event) {
    if (!elements.interactiveCanvas) return null;
    const rect = elements.interactiveCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const scaleX = elements.interactiveCanvas.width / rect.width;
    const scaleY = elements.interactiveCanvas.height / rect.height;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;
    return [x, y];
}

function handleInteractiveCanvasPointerDown(event) {
    if (!state.currentImage) return;
    if (event.button !== 0 && event.button !== 2) return;
    if (!elements.interactiveCanvas) return;
    event.preventDefault();

    const view = state.interactiveView;
    view.pointerId = event.pointerId;
    view.isDragging = false;
    view.startClientX = event.clientX;
    view.startClientY = event.clientY;
    view.startOffsetX = view.offsetX;
    view.startOffsetY = view.offsetY;
    view.pendingLabel = event.button === 2 ? 0 : 1;

    try {
        elements.interactiveCanvas.setPointerCapture(event.pointerId);
    } catch (error) {
        // no-op
    }
}

function handleInteractiveCanvasPointerMove(event) {
    const view = state.interactiveView;
    if (view.pointerId !== event.pointerId) return;
    const dx = event.clientX - view.startClientX;
    const dy = event.clientY - view.startClientY;
    if (!view.isDragging && Math.hypot(dx, dy) >= INTERACTIVE_PAN_DRAG_THRESHOLD) {
        view.isDragging = true;
        setInteractiveCanvasDragging(true);
    }
    if (!view.isDragging) return;

    view.offsetX = view.startOffsetX + dx;
    view.offsetY = view.startOffsetY + dy;
    updateZoom();
}

function handleInteractiveCanvasPointerUp(event) {
    const view = state.interactiveView;
    if (view.pointerId !== event.pointerId) return;

    const wasDragging = view.isDragging;
    const label = view.pendingLabel;
    view.pointerId = null;
    view.isDragging = false;
    setInteractiveCanvasDragging(false);

    if (elements.interactiveCanvas) {
        try {
            elements.interactiveCanvas.releasePointerCapture(event.pointerId);
        } catch (error) {
            // no-op
        }
    }

    if (!wasDragging) {
        handleCanvasClick(event, label);
    }
}

function handleInteractiveCanvasWheel(event) {
    if (!state.currentImage) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 0.89;
    state.zoom = Math.max(0.3, Math.min(4, state.zoom * factor));
    updateZoom();
}

function openInteractiveEditorModal() {
    if (!state.currentImage) {
        showSamNotice('请先选择图片后再放大标注', 'warn', 2200);
        return;
    }
    if (!elements.interactiveEditorModal || !elements.interactiveEditorStage || !elements.interactiveCanvasContainer) {
        return;
    }
    if (state.interactiveEditor.open) return;

    state.interactiveEditor.open = true;
    elements.interactiveCanvasContainer.classList.add('interactive-editor-mounted');
    elements.interactiveEditorStage.appendChild(elements.interactiveCanvasContainer);
    elements.interactiveEditorModal.style.display = 'flex';
    updateZoom();
}

function closeInteractiveEditorModal() {
    if (!state.interactiveEditor.open) return;
    state.interactiveEditor.open = false;
    state.interactiveView.pointerId = null;
    state.interactiveView.isDragging = false;
    setInteractiveCanvasDragging(false);
    if (elements.interactiveCanvasContainer) {
        elements.interactiveCanvasContainer.classList.remove('interactive-editor-mounted');
    }
    if (elements.interactiveCanvasHost && elements.interactiveCanvasContainer) {
        elements.interactiveCanvasHost.appendChild(elements.interactiveCanvasContainer);
    }
    if (elements.interactiveEditorModal) {
        elements.interactiveEditorModal.style.display = 'none';
    }
    updateZoom();
}

function getSinglePreviewImageSrc(type) {
    const viewer = state.singlePreviewViewer;
    if (type === 'result' && viewer.externalResultSrc) {
        return viewer.externalResultSrc;
    }
    if (type !== 'result' && viewer.externalOriginalSrc) {
        return viewer.externalOriginalSrc;
    }
    if (type === 'result') {
        return elements.singleResult?.src || '';
    }
    return elements.singleOriginal?.src || '';
}

function setSinglePreviewExternalSources(originalSrc = '', resultSrc = '') {
    const viewer = state.singlePreviewViewer;
    viewer.externalOriginalSrc = typeof originalSrc === 'string' ? originalSrc : '';
    viewer.externalResultSrc = typeof resultSrc === 'string' ? resultSrc : '';
}

function updateSinglePreviewTransform() {
    if (!elements.imagePreviewImage) return;
    const viewer = state.singlePreviewViewer;
    elements.imagePreviewImage.style.transform =
        `translate(${viewer.offsetX}px, ${viewer.offsetY}px) scale(${viewer.zoom})`;
    setTextContent(elements.previewZoomValue, `${Math.round(viewer.zoom * 100)}%`);
}

function switchSinglePreviewType(type, options = {}) {
    const viewer = state.singlePreviewViewer;
    const keepTransform = !!options.keepTransform;
    let targetType = type === 'result' ? 'result' : 'original';
    let src = getSinglePreviewImageSrc(targetType);
    if (!src && targetType === 'result') {
        targetType = 'original';
        src = getSinglePreviewImageSrc(targetType);
    }
    if (!src || !elements.imagePreviewImage || !isRenderablePreviewUrl(src)) {
        return false;
    }

    viewer.activeType = targetType;
    elements.imagePreviewImage.src = src;

    const hasResult = !!getSinglePreviewImageSrc('result');
    if (elements.previewTabResult) {
        elements.previewTabResult.disabled = !hasResult;
        elements.previewTabResult.classList.toggle('active', targetType === 'result');
    }
    if (elements.previewTabOriginal) {
        elements.previewTabOriginal.classList.toggle('active', targetType === 'original');
    }

    if (!keepTransform) {
        viewer.zoom = 1;
        viewer.offsetX = 0;
        viewer.offsetY = 0;
    }
    updateSinglePreviewTransform();
    return true;
}

function closeSinglePreviewViewer() {
    if (!elements.imagePreviewModal) return;
    const viewer = state.singlePreviewViewer;
    viewer.open = false;
    viewer.isDragging = false;
    setSinglePreviewExternalSources('', '');
    elements.imagePreviewModal.style.display = 'none';
    if (elements.imagePreviewStage) {
        elements.imagePreviewStage.classList.remove('dragging');
    }
}

function openSinglePreviewViewer(type) {
    if (!elements.imagePreviewModal) return;
    const switched = switchSinglePreviewType(type, { keepTransform: false });
    if (!switched) return;
    state.singlePreviewViewer.open = true;
    elements.imagePreviewModal.style.display = 'flex';
}

function setSinglePreviewZoom(nextZoom) {
    const viewer = state.singlePreviewViewer;
    viewer.zoom = Math.max(viewer.minZoom, Math.min(viewer.maxZoom, nextZoom));
    updateSinglePreviewTransform();
}

function initSinglePreviewViewer() {
    if (!elements.imagePreviewModal || elements.imagePreviewModal.dataset.bound === '1') {
        return;
    }
    elements.imagePreviewModal.dataset.bound = '1';

    elements.singleOriginal?.addEventListener('click', () => {
        if (!elements.singleOriginal.src) return;
        setSinglePreviewExternalSources('', '');
        openSinglePreviewViewer('original');
    });
    elements.singleResult?.addEventListener('click', () => {
        if (!elements.singleResult.src) return;
        setSinglePreviewExternalSources('', '');
        openSinglePreviewViewer('result');
    });

    elements.previewTabOriginal?.addEventListener('click', () => {
        switchSinglePreviewType('original', { keepTransform: false });
    });
    elements.previewTabResult?.addEventListener('click', () => {
        switchSinglePreviewType('result', { keepTransform: false });
    });
    elements.previewZoomIn?.addEventListener('click', () => {
        setSinglePreviewZoom(state.singlePreviewViewer.zoom * 1.15);
    });
    elements.previewZoomOut?.addEventListener('click', () => {
        setSinglePreviewZoom(state.singlePreviewViewer.zoom / 1.15);
    });
    elements.previewZoomReset?.addEventListener('click', () => {
        const viewer = state.singlePreviewViewer;
        viewer.zoom = 1;
        viewer.offsetX = 0;
        viewer.offsetY = 0;
        updateSinglePreviewTransform();
    });
    elements.previewCloseBtn?.addEventListener('click', () => {
        closeSinglePreviewViewer();
    });

    elements.imagePreviewModal.addEventListener('click', (evt) => {
        if (evt.target === elements.imagePreviewModal) {
            closeSinglePreviewViewer();
        }
    });

    elements.imagePreviewStage?.addEventListener('wheel', (evt) => {
        if (!state.singlePreviewViewer.open) return;
        evt.preventDefault();
        const factor = evt.deltaY < 0 ? 1.12 : 0.89;
        setSinglePreviewZoom(state.singlePreviewViewer.zoom * factor);
    }, { passive: false });

    elements.imagePreviewStage?.addEventListener('pointerdown', (evt) => {
        if (!state.singlePreviewViewer.open || evt.button !== 0) return;
        const viewer = state.singlePreviewViewer;
        viewer.isDragging = true;
        viewer.dragStartX = evt.clientX;
        viewer.dragStartY = evt.clientY;
        viewer.dragStartOffsetX = viewer.offsetX;
        viewer.dragStartOffsetY = viewer.offsetY;
        elements.imagePreviewStage.classList.add('dragging');
    });

    window.addEventListener('pointermove', (evt) => {
        const viewer = state.singlePreviewViewer;
        if (!viewer.isDragging) return;
        viewer.offsetX = viewer.dragStartOffsetX + (evt.clientX - viewer.dragStartX);
        viewer.offsetY = viewer.dragStartOffsetY + (evt.clientY - viewer.dragStartY);
        updateSinglePreviewTransform();
    });

    window.addEventListener('pointerup', () => {
        const viewer = state.singlePreviewViewer;
        if (!viewer.isDragging) return;
        viewer.isDragging = false;
        elements.imagePreviewStage?.classList.remove('dragging');
    });

    window.addEventListener('keydown', (evt) => {
        if (!state.singlePreviewViewer.open) return;
        if (evt.key === 'Escape') {
            evt.preventDefault();
            closeSinglePreviewViewer();
            return;
        }
        if (evt.key === '+' || evt.key === '=') {
            evt.preventDefault();
            setSinglePreviewZoom(state.singlePreviewViewer.zoom * 1.15);
            return;
        }
        if (evt.key === '-') {
            evt.preventDefault();
            setSinglePreviewZoom(state.singlePreviewViewer.zoom / 1.15);
        }
    });
}

function escapeHtml(value) {
    if (typeof value !== 'string') return '';
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getBaseName(filePath) {
    if (typeof filePath !== 'string') return '';
    const normalized = filePath.replace(/\\/g, '/');
    const index = normalized.lastIndexOf('/');
    return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function clampTaskParallel(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 1;
    return Math.max(1, Math.min(8, parsed));
}

function createTaskOutputPath(inputPath, suffix = 'no_bg') {
    if (typeof inputPath !== 'string' || !inputPath.trim()) {
        return '';
    }
    const stamp = Date.now();
    if (/\.[^/.]+$/.test(inputPath)) {
        return inputPath.replace(/\.[^/.]+$/, `_${suffix}_${stamp}.png`);
    }
    return `${inputPath}_${suffix}_${stamp}.png`;
}

function getConfiguredOutputFormat() {
    return elements.outputFormat?.value === 'jpg' ? 'jpg' : 'png';
}

function stripFileExtension(fileName) {
    if (typeof fileName !== 'string') return '';
    return fileName.replace(/\.[^/.]+$/, '');
}

function getSaveDialogProfile(sourcePath, fallbackBaseName = 'sam-result') {
    const format = getConfiguredOutputFormat();
    const ext = format === 'jpg' ? 'jpg' : 'png';
    const filter = format === 'jpg'
        ? { name: 'JPG', extensions: ['jpg', 'jpeg'] }
        : { name: 'PNG', extensions: ['png'] };
    const sourceName = stripFileExtension(getBaseName(sourcePath || ''));
    const baseName = sourceName || fallbackBaseName;
    return {
        ext,
        filter,
        defaultPath: `${baseName}.${ext}`,
    };
}

function normalizeSavePath(savePath, ext, allowedExtensions = []) {
    const normalized = normalizeSinglePath(savePath);
    if (!normalized) return '';
    const lower = normalized.toLowerCase();
    const matched = allowedExtensions.some((candidate) => lower.endsWith(`.${candidate}`));
    if (matched) return normalized;
    return `${normalized}.${ext}`;
}

async function saveResultToLocal(sourcePath, fallbackBaseName = 'sam-result') {
    if (!sourcePath) return false;
    const profile = getSaveDialogProfile(sourcePath, fallbackBaseName);
    const selected = await save({
        defaultPath: profile.defaultPath,
        filters: [profile.filter],
    });
    const destination = normalizeSavePath(selected, profile.ext, profile.filter.extensions);
    if (!destination) return false;
    await invoke('copy_file', {
        source: sourcePath,
        destination,
    });
    return true;
}

function getTaskStatusText(status) {
    if (status === 'queued') return '排队中';
    if (status === 'running') return '执行中';
    if (status === 'success') return '已完成';
    if (status === 'failed') return '失败';
    return '未知';
}

function updateTaskSummary() {
    const total = state.tasks.length;
    const running = state.tasks.filter((task) => task.status === 'running').length;
    const queued = state.tasks.filter((task) => task.status === 'queued').length;
    if (elements.taskCount) elements.taskCount.textContent = String(total);
    if (elements.taskRunningCount) elements.taskRunningCount.textContent = String(running);
    if (elements.taskQueuedCount) elements.taskQueuedCount.textContent = String(queued);
}

function getTaskById(taskId) {
    return state.tasks.find((task) => task.id === taskId) || null;
}

function inferTaskType(task) {
    const explicitType = task?.taskMeta?.type;
    if (explicitType === 'interactive' || explicitType === 'single' || explicitType === 'batch') {
        return explicitType;
    }
    const title = String(task?.title || '');
    if (title.startsWith('交互式抠图')) return 'interactive';
    if (title.startsWith('单张抠图')) return 'single';
    if (title.startsWith('批量抠图')) return 'batch';
    return 'unknown';
}

function normalizeInteractiveSnapshot(snapshot, fallbackImagePath = '') {
    if (!snapshot || typeof snapshot !== 'object') {
        return null;
    }
    const imagePath = normalizeSinglePath(snapshot.imagePath || fallbackImagePath);
    if (!imagePath) {
        return null;
    }

    const options = snapshot.options || {};
    const selectMode = options.selectMode === 'largest_area' || options.selectMode === 'smallest_area'
        ? options.selectMode
        : 'best_score';
    const smoothRadius = toClampedFloat(options.smoothRadius, 0.6, 0, 12);
    const alphaThreshold = toClampedInt(options.alphaThreshold, 6, 0, 200);
    const localZoom = toClampedFloat(options.localZoom, 1.8, 1, 4);

    const pointsRaw = Array.isArray(snapshot.points) ? snapshot.points : [];
    const points = pointsRaw
        .map((point) => {
            if (!Array.isArray(point) || point.length < 2) return null;
            const x = Number(point[0]);
            const y = Number(point[1]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
            return [x, y];
        })
        .filter((point) => point !== null);

    const labelsRaw = Array.isArray(snapshot.labels) ? snapshot.labels : [];
    const labels = points.map((_, index) => {
        const value = Number(labelsRaw[index]);
        return value === 0 ? 0 : 1;
    });

    return {
        imagePath,
        points,
        labels,
        options: {
            selectMode,
            smoothRadius,
            alphaThreshold,
            localZoom,
        },
    };
}

function buildInteractiveSnapshot(imagePath, points, labels, options) {
    return normalizeInteractiveSnapshot({
        imagePath,
        points: Array.isArray(points) ? points.map((point) => [point[0], point[1]]) : [],
        labels: Array.isArray(labels) ? [...labels] : [],
        options: options ? { ...options } : {},
    }, imagePath);
}

function getTaskEditCapabilities(task) {
    const type = inferTaskType(task);
    const hasInput = !!task?.inputPath;
    const hasOutput = task?.status === 'success' && !!task?.outputPath;
    const interactiveSnapshot = type === 'interactive'
        ? normalizeInteractiveSnapshot(task?.taskMeta?.snapshot, task?.inputPath || '')
        : null;
    return {
        type,
        interactiveSnapshot,
        canEditOriginal: (type === 'interactive' || type === 'single') && hasInput,
        canEditPoints: type === 'interactive' && !!interactiveSnapshot,
        canEditResult: (type === 'interactive' || type === 'single') && hasOutput,
    };
}

function renderTaskList() {
    if (!elements.taskList || !elements.taskEmpty) {
        return;
    }

    updateTaskSummary();
    if (state.tasks.length === 0) {
        elements.taskEmpty.style.display = 'block';
        elements.taskList.innerHTML = '';
        return;
    }

    elements.taskEmpty.style.display = 'none';
    const html = state.tasks.map((task) => {
        const canPreview = !!task.inputPath;
        const canSave = task.status === 'success' && !!task.outputPath;
        const editCaps = getTaskEditCapabilities(task);
        const originalThumb = task.originalPreview
            ? `<img src="${task.originalPreview}" alt="原图缩略图">`
            : '<span>原图预览</span>';
        const resultThumb = task.resultPreview
            ? `<img src="${task.resultPreview}" alt="结果缩略图">`
            : '<span>结果预览</span>';
        const message = task.message ? escapeHtml(task.message) : '&nbsp;';
        const actions = [];
        const isEditableTask = editCaps.type === 'interactive' || editCaps.type === 'single';
        if (isEditableTask) {
            actions.push(`<button class="btn-secondary" data-task-action="edit-original" ${editCaps.canEditOriginal ? '' : 'disabled'}>原图编辑</button>`);
            actions.push(`<button class="btn-secondary" data-task-action="edit-points" ${editCaps.canEditPoints ? '' : 'disabled'}>点位续编</button>`);
            actions.push(`<button class="btn-secondary" data-task-action="edit-result" ${editCaps.canEditResult ? '' : 'disabled'}>结果续抠</button>`);
        }
        actions.push(`<button class="btn-secondary" data-task-action="preview" ${canPreview ? '' : 'disabled'}>大图预览</button>`);
        actions.push(`<button class="btn-primary" data-task-action="save" ${canSave ? '' : 'disabled'}>保存到本地</button>`);

        return `
            <div class="task-card ${task.status}" data-task-id="${task.id}">
                <div class="task-card-header">
                    <div class="task-title">${escapeHtml(task.title)}</div>
                    <span class="task-status ${task.status}">${getTaskStatusText(task.status)}</span>
                </div>
                <div class="task-thumbs">
                    <div class="task-thumb">${originalThumb}</div>
                    <div class="task-thumb">${resultThumb}</div>
                </div>
                <div class="task-card-message">${message}</div>
                <div class="task-card-actions">
                    ${actions.join('')}
                </div>
            </div>
        `;
    }).join('');
    elements.taskList.innerHTML = html;

    state.tasks.forEach((task) => {
        void ensureTaskPreview(task, 'original');
        if (task.status === 'success') {
            void ensureTaskPreview(task, 'result');
        }
    });
}

async function ensureTaskPreview(task, type) {
    if (!task) return;
    const isOriginal = type === 'original';
    const path = isOriginal ? task.inputPath : task.outputPath;
    if (!path) return;

    const srcKey = isOriginal ? 'originalPreview' : 'resultPreview';
    const loadingKey = isOriginal ? 'isLoadingOriginalPreview' : 'isLoadingResultPreview';
    if (task[srcKey] || task[loadingKey]) return;

    task[loadingKey] = true;
    try {
        const src = await getImagePreview(path);
        if (isRenderablePreviewUrl(src)) {
            task[srcKey] = src;
            renderTaskList();
        }
    } catch (error) {
        console.warn('Failed to load task preview:', error);
    } finally {
        task[loadingKey] = false;
    }
}

async function openTaskPreview(taskId) {
    const task = getTaskById(taskId);
    if (!task || !elements.imagePreviewModal) return;

    let originalSrc = task.originalPreview || '';
    if (!originalSrc && task.inputPath) {
        originalSrc = await getImagePreview(task.inputPath);
    }
    let resultSrc = task.resultPreview || '';
    if (!resultSrc && task.status === 'success' && task.outputPath) {
        resultSrc = await getImagePreview(task.outputPath);
    }

    if (!isRenderablePreviewUrl(originalSrc) && !isRenderablePreviewUrl(resultSrc)) {
        showSamNotice('任务预览不可用：图片地址无效', 'warn', 2600);
        return;
    }

    setSinglePreviewExternalSources(
        isRenderablePreviewUrl(originalSrc) ? originalSrc : '',
        isRenderablePreviewUrl(resultSrc) ? resultSrc : ''
    );
    openSinglePreviewViewer(isRenderablePreviewUrl(resultSrc) ? 'result' : 'original');
}

function closeTaskPreview() {
    closeSinglePreviewViewer();
}

async function saveTaskResult(taskId) {
    const task = getTaskById(taskId);
    if (!task || task.status !== 'success' || !task.outputPath) {
        return;
    }
    const ok = await saveResultToLocal(task.outputPath, 'sam-result');
    if (ok) {
        showSamNotice('任务结果已保存', 'success', 2200);
    }
}

async function startInteractiveTaskEditing({
    imagePath,
    options = null,
    points = [],
    labels = [],
    notice = '已进入交互式编辑，可继续调优',
}) {
    const normalizedPath = normalizeSinglePath(imagePath);
    if (!normalizedPath) {
        showSamNotice('编辑失败：缺少图片路径', 'error', 3200);
        return;
    }

    closeTaskPreview();
    closeInteractiveEditorModal();

    if (options && typeof options === 'object') {
        state.interactiveOptions = {
            ...state.interactiveOptions,
            ...options,
        };
        syncInteractiveControlsFromState();
    }

    activateTab('interactive');
    await loadInteractiveImage(normalizedPath);
    state.interactivePoints = Array.isArray(points) ? points.map((point) => [point[0], point[1]]) : [];
    state.interactiveLabels = Array.isArray(labels) ? [...labels] : [];
    state.currentResult = null;
    if (elements.interactiveSave) {
        elements.interactiveSave.disabled = true;
    }
    await redrawCanvas();
    openInteractiveEditorModal();
    showSamNotice(notice, 'success', 2600);
}

async function editTask(taskId, action) {
    const task = getTaskById(taskId);
    if (!task) return;
    const editCaps = getTaskEditCapabilities(task);

    if (action === 'edit-points') {
        if (!editCaps.canEditPoints || !editCaps.interactiveSnapshot) {
            showSamNotice('该任务没有可恢复的点位信息', 'warn', 2600);
            return;
        }
        await startInteractiveTaskEditing({
            imagePath: editCaps.interactiveSnapshot.imagePath,
            options: editCaps.interactiveSnapshot.options,
            points: editCaps.interactiveSnapshot.points,
            labels: editCaps.interactiveSnapshot.labels,
            notice: '已恢复历史点位，可继续编辑后再次抠图',
        });
        return;
    }

    if (action === 'edit-original') {
        if (!editCaps.canEditOriginal) {
            showSamNotice('该任务暂不支持原图编辑', 'warn', 2600);
            return;
        }
        const options = editCaps.interactiveSnapshot?.options || null;
        await startInteractiveTaskEditing({
            imagePath: task.inputPath,
            options,
            points: [],
            labels: [],
            notice: '已载入原图，可重新标记继续抠图',
        });
        return;
    }

    if (action === 'edit-result') {
        if (!editCaps.canEditResult) {
            showSamNotice('该任务还没有可继续编辑的结果图', 'warn', 2600);
            return;
        }
        const options = editCaps.interactiveSnapshot?.options || null;
        await startInteractiveTaskEditing({
            imagePath: task.outputPath,
            options,
            points: [],
            labels: [],
            notice: '已载入抠图结果，可继续二次抠图',
        });
    }
}

function clearFinishedTasks() {
    const before = state.tasks.length;
    state.tasks = state.tasks.filter((task) => task.status === 'queued' || task.status === 'running');
    const removed = before - state.tasks.length;
    renderTaskList();
    if (removed > 0) {
        showSamNotice(`已清理 ${removed} 条已完成/失败任务`, 'success', 2200);
    }
}

function setTaskMaxParallel(value, options = {}) {
    const next = clampTaskParallel(value);
    state.taskMaxParallel = next;
    if (!options.skipPersist) {
        localStorage.setItem(TASK_MAX_PARALLEL_STORAGE_KEY, String(next));
    }
    if (elements.taskMaxParallel) {
        elements.taskMaxParallel.value = String(next);
    }
    void processTaskQueue();
}

function initTaskModule() {
    const cached = localStorage.getItem(TASK_MAX_PARALLEL_STORAGE_KEY);
    setTaskMaxParallel(cached || state.taskMaxParallel, { skipPersist: true });

    if (elements.taskMaxParallel) {
        elements.taskMaxParallel.addEventListener('change', (event) => {
            const target = event.target;
            setTaskMaxParallel(target?.value);
        });
    }

    if (elements.taskList) {
        elements.taskList.addEventListener('click', async (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const btn = target.closest('button[data-task-action]');
            const card = target.closest('.task-card');
            if (!btn || !card) return;
            const taskId = card.dataset.taskId;
            const action = btn.dataset.taskAction;
            if (!taskId || !action) return;
            if (action === 'edit-original' || action === 'edit-points' || action === 'edit-result') {
                await editTask(taskId, action);
                return;
            }
            if (action === 'preview') {
                await openTaskPreview(taskId);
                return;
            }
            if (action === 'save') {
                try {
                    await saveTaskResult(taskId);
                } catch (error) {
                    showSamNotice(`保存失败: ${error}`, 'error', 4200);
                }
            }
        });
    }

    elements.taskClearFinished?.addEventListener('click', () => {
        clearFinishedTasks();
    });
    renderTaskList();
}

function createTask({
    title,
    inputPath = '',
    outputPath = '',
    execute,
    onSuccess = null,
    taskMeta = null,
}) {
    const taskId = `sam-task-${Date.now()}-${++state.taskSeq}`;
    const task = {
        id: taskId,
        title: title || '抠图任务',
        inputPath,
        outputPath,
        status: 'queued',
        message: '等待执行',
        originalPreview: '',
        resultPreview: '',
        isLoadingOriginalPreview: false,
        isLoadingResultPreview: false,
        taskMeta,
        execute,
        onSuccess,
        createdAt: Date.now(),
    };
    state.tasks.unshift(task);
    renderTaskList();
    void processTaskQueue();
    return task;
}

async function runTask(task) {
    task.status = 'running';
    task.message = '执行中...';
    state.taskRunningCount += 1;
    renderTaskList();

    try {
        const result = await task.execute();
        const success = !!result?.success;
        if (!success) {
            throw new Error(result?.message || '任务执行失败');
        }
        task.status = 'success';
        task.message = result?.message || '执行完成';
        if (typeof result?.outputPath === 'string' && result.outputPath.trim()) {
            task.outputPath = result.outputPath;
        }
        if (typeof task.onSuccess === 'function') {
            await task.onSuccess(result);
        }
        showSamNotice(`${task.title} 已完成`, 'success', 1800);
    } catch (error) {
        task.status = 'failed';
        task.message = error instanceof Error ? error.message : String(error);
        showSamNotice(`${task.title} 失败: ${task.message}`, 'error', 3600);
    } finally {
        state.taskRunningCount = Math.max(0, state.taskRunningCount - 1);
        renderTaskList();
        void processTaskQueue();
    }
}

async function processTaskQueue() {
    while (state.taskRunningCount < state.taskMaxParallel) {
        const nextTask = state.tasks
            .filter((task) => task.status === 'queued')
            .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!nextTask) {
            break;
        }
        void runTask(nextTask);
    }
}

// ========== 单张模式 ==========
function initSingleMode() {
    initSingleOptionsControls();
    initSinglePreviewViewer();

    // 点击上传区域
    elements.singleUpload.addEventListener('click', () => {
        elements.singleFile.click();
    });
    
    // 拖拽上传
    elements.singleUpload.addEventListener('dragover', (e) => {
        e.preventDefault();
        elements.singleUpload.classList.add('dragover');
    });
    
    elements.singleUpload.addEventListener('dragleave', () => {
        elements.singleUpload.classList.remove('dragover');
    });
    
    elements.singleUpload.addEventListener('drop', (e) => {
        e.preventDefault();
        elements.singleUpload.classList.remove('dragover');
        
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            void handleSingleFile(files[0]);
        }
    });
    
    // 文件选择
    elements.singleFile.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleSingleFile(e.target.files[0]);
        }
    });
    
    // 自动抠图
    elements.singleProcess.addEventListener('click', async () => {
        if (!state.currentImage) {
            showSamNotice('请先选择图片', 'warn', 2600);
            return;
        }
        
        if (!(await ensureModelReady('自动抠图'))) {
            return;
        }

        const imagePath = state.currentImage;
        const outputPath = createTaskOutputPath(imagePath, 'no_bg');
        const optionsPayload = getSingleAutoOptionsPayload();
        createTask({
            title: `单张抠图 · ${getBaseName(imagePath) || '未命名'}`,
            inputPath: imagePath,
            outputPath,
            taskMeta: {
                type: 'single',
            },
            execute: async () => {
                const result = await invoke('auto_remove_background', {
                    imagePath,
                    outputPath,
                    options: optionsPayload,
                });
                return {
                    success: !!result?.success,
                    message: result?.message || '',
                    outputPath,
                };
            },
            onSuccess: async () => {
                if (state.currentImage === imagePath) {
                    state.currentResult = outputPath;
                    await setPreviewImageSrc(elements.singleResult, outputPath, '抠图结果');
                    elements.singleSave.disabled = false;
                }
            }
        });
        showSamNotice('已创建抠图任务，正在队列中执行', 'success', 2200);
    });
    
    // 保存结果
    elements.singleSave.addEventListener('click', async () => {
        if (!state.currentResult) return;
        try {
            const ok = await saveResultToLocal(state.currentResult, 'sam-result');
            if (ok) {
                alert('保存成功！');
            }
        } catch (e) {
            alert('保存失败: ' + e);
        }
    });
    
    // 清除
    elements.singleClear.addEventListener('click', () => {
        state.currentImage = null;
        state.currentResult = null;
        closeSinglePreviewViewer();
        elements.singlePreview.style.display = 'none';
        elements.singleUpload.style.display = 'block';
        elements.singleOriginal.src = '';
        elements.singleResult.src = '';
        elements.singleSave.disabled = true;
        elements.singleFile.value = '';
    });
}

// 处理单张文件
async function handleSingleFile(file) {
    try {
        let filePath = await ensureImagePathFromFile(file);

        if (!filePath) {
            filePath = await open({
                filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'tiff', 'webp'] }],
                multiple: false
            });
        }
        
        filePath = normalizeSinglePath(filePath);
        if (!filePath) return;

        if (!filePath || typeof filePath !== 'string') {
            alert('无法识别图片路径，请点击上传区域重新选择文件');
            return;
        }
        
        state.currentImage = filePath;
        
        // 显示预览
        const singleOriginalPreview = await setPreviewImageSrc(elements.singleOriginal, filePath, '原图');
        if (!singleOriginalPreview) {
            return;
        }
        elements.singleUpload.style.display = 'none';
        elements.singlePreview.style.display = 'block';
    } catch (error) {
        console.error('handleSingleFile failed:', error);
        alert(`加载图片失败: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// ========== 交互式模式 ==========
function initInteractiveMode() {
    initInteractiveOptionsControls();
    if (elements.interactiveCanvasContainer) {
        elements.interactiveCanvasContainer.classList.add('interactive-pan');
    }

    // 上传
    elements.interactiveUpload.addEventListener('click', () => {
        if (elements.interactiveFile) {
            elements.interactiveFile.value = '';
            elements.interactiveFile.click();
        }
    });

    elements.interactiveFile.addEventListener('change', (e) => {
        const files = e.target?.files;
        if (!files || files.length === 0) return;
        void handleInteractiveFile(files[0]);
    });

    elements.interactiveUpload.addEventListener('dragover', (e) => {
        e.preventDefault();
        elements.interactiveUpload.classList.add('dragover');
    });

    elements.interactiveUpload.addEventListener('dragleave', () => {
        elements.interactiveUpload.classList.remove('dragover');
    });

    elements.interactiveUpload.addEventListener('drop', (e) => {
        e.preventDefault();
        elements.interactiveUpload.classList.remove('dragover');
        const files = e.dataTransfer?.files;
        if (!files || files.length === 0) return;
        const droppedPath = resolveFilePathFromDrop(files[0]);
        if (!droppedPath) {
            void handleInteractiveFile(files[0]);
        } else {
            void loadInteractiveImage(droppedPath);
        }
    });
    
    // Canvas 交互（拖拽平移 + 点击标记）
    elements.interactiveCanvas.addEventListener('pointerdown', handleInteractiveCanvasPointerDown);
    window.addEventListener('pointermove', handleInteractiveCanvasPointerMove);
    window.addEventListener('pointerup', handleInteractiveCanvasPointerUp);
    window.addEventListener('pointercancel', handleInteractiveCanvasPointerUp);
    elements.interactiveCanvasContainer?.addEventListener('wheel', handleInteractiveCanvasWheel, { passive: false });
    elements.interactiveCanvasContainer?.addEventListener('dblclick', (e) => {
        e.preventDefault();
        openInteractiveEditorModal();
    });

    elements.interactiveCanvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
    });

    elements.interactiveOpenPreview?.addEventListener('click', () => {
        openInteractiveEditorModal();
    });
    elements.interactiveEditorCloseBtn?.addEventListener('click', () => {
        closeInteractiveEditorModal();
    });
    elements.interactiveEditorModal?.addEventListener('click', (evt) => {
        if (evt.target === elements.interactiveEditorModal) {
            closeInteractiveEditorModal();
        }
    });
    window.addEventListener('keydown', (evt) => {
        if (!state.interactiveEditor.open) return;
        if (evt.key === 'Escape') {
            evt.preventDefault();
            closeInteractiveEditorModal();
        }
    });
    
    // 撤销
    elements.toolUndo.addEventListener('click', () => {
        if (state.interactivePoints.length > 0) {
            state.interactivePoints.pop();
            state.interactiveLabels.pop();
            redrawCanvas();
        }
    });
    
    // 清空
    elements.toolClear.addEventListener('click', () => {
        state.interactivePoints = [];
        state.interactiveLabels = [];
        redrawCanvas();
    });
    
    // 缩放
    elements.zoomIn.addEventListener('click', () => {
        state.zoom = Math.min(state.zoom * 1.2, 4);
        updateZoom();
    });
    
    elements.zoomOut.addEventListener('click', () => {
        state.zoom = Math.max(state.zoom / 1.2, 0.5);
        updateZoom();
    });
    
    // 应用抠图
    elements.interactiveProcess.addEventListener('click', async () => {
        if (!state.currentImage) {
            showSamNotice('请先选择图片', 'warn', 2600);
            return;
        }
        if (state.interactivePoints.length === 0) {
            showSamNotice('请至少选择一个点', 'warn', 2600);
            return;
        }
        
        if (!(await ensureModelReady('交互式抠图'))) {
            return;
        }

        const imagePath = state.currentImage;
        const outputPath = createTaskOutputPath(imagePath, 'interactive_no_bg');
        const points = state.interactivePoints.map((point) => [point[0], point[1]]);
        const labels = [...state.interactiveLabels];
        const optionsPayload = getInteractiveOptionsPayload();
        const interactiveSnapshot = buildInteractiveSnapshot(
            imagePath,
            points,
            labels,
            state.interactiveOptions
        );

        createTask({
            title: `交互式抠图 · ${getBaseName(imagePath) || '未命名'}`,
            inputPath: imagePath,
            outputPath,
            taskMeta: {
                type: 'interactive',
                snapshot: interactiveSnapshot,
            },
            execute: async () => {
                const result = await invoke('interactive_remove_background', {
                    imagePath,
                    outputPath,
                    points,
                    labels,
                    options: optionsPayload
                });
                return {
                    success: !!result?.success,
                    message: result?.message || '',
                    outputPath,
                };
            },
            onSuccess: async () => {
                if (state.currentImage !== imagePath) {
                    return;
                }
                state.currentResult = outputPath;
                const resultImg = await loadPreviewImageElement(outputPath, '交互式结果');
                if (!resultImg) {
                    return;
                }
                const ctx = elements.interactiveCanvas.getContext('2d');
                ctx.clearRect(0, 0, elements.interactiveCanvas.width, elements.interactiveCanvas.height);
                ctx.drawImage(resultImg, 0, 0);
                elements.interactiveSave.disabled = false;
            }
        });
        showSamNotice('已创建交互式任务，正在队列中执行', 'success', 2200);
    });
    
    // 保存
    elements.interactiveSave.addEventListener('click', async () => {
        if (!state.currentResult) return;
        try {
            const ok = await saveResultToLocal(state.currentResult, 'sam-result');
            if (ok) {
                alert('保存成功！');
            }
        } catch (e) {
            alert('保存失败: ' + e);
        }
    });
}

async function handleInteractiveFile(file) {
    try {
        const resolvedPath = await ensureImagePathFromFile(file);
        if (!resolvedPath) {
            alert('未拿到拖拽文件路径，请点击上传区域选择图片');
            return;
        }
        await loadInteractiveImage(resolvedPath);
    } catch (error) {
        console.error('handleInteractiveFile failed:', error);
        alert(`加载交互式图片失败: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function resolveFilePathFromDrop(file) {
    if (!file || typeof file !== 'object') return '';
    const directPath = file.path || file.filepath || file.fullPath || '';
    if (typeof directPath === 'string' && directPath.trim()) {
        return directPath.trim();
    }

    // 某些环境下 path 在 _file/path 结构中
    const nestedPath = file._file?.path || file._file?.filepath || '';
    if (typeof nestedPath === 'string' && nestedPath.trim()) {
        return nestedPath.trim();
    }
    return '';
}

function normalizeSinglePath(filePath) {
    if (Array.isArray(filePath)) {
        return filePath[0] || '';
    }
    if (typeof filePath === 'string') {
        return filePath;
    }
    return '';
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

async function ensureImagePathFromFile(file) {
    let filePath = resolveFilePathFromDrop(file);
    if (filePath) {
        return filePath;
    }

    if (!file || typeof file.arrayBuffer !== 'function') {
        return '';
    }

    try {
        const buffer = await file.arrayBuffer();
        if (!buffer || buffer.byteLength === 0) {
            return '';
        }
        const imageBase64 = arrayBufferToBase64(buffer);
        const fileName = typeof file.name === 'string' && file.name.trim()
            ? file.name.trim()
            : 'dropped-image.png';
        const savedPath = await invoke('save_temp_image', { fileName, imageBase64 });
        return normalizeSinglePath(savedPath);
    } catch (error) {
        console.error('Failed to save dropped image as temp file:', error);
        return '';
    }
}

// 加载交互式图片
async function loadInteractiveImage(filePath) {
    filePath = normalizeSinglePath(filePath);
    if (!filePath || typeof filePath !== 'string') {
        alert('图片路径无效，请重新选择');
        return;
    }

    state.currentImage = filePath;
    state.interactivePoints = [];
    state.interactiveLabels = [];
    
    const img = await loadPreviewImageElement(filePath, '交互原图');
    if (!img) {
        return;
    }
    elements.interactiveCanvas.width = img.width;
    elements.interactiveCanvas.height = img.height;
    const ctx = elements.interactiveCanvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    state.interactiveView.offsetX = 0;
    state.interactiveView.offsetY = 0;
    state.interactiveView.isDragging = false;
    state.interactiveView.pointerId = null;
    setInteractiveCanvasDragging(false);
    state.zoom = state.interactiveOptions.localZoom;
    updateZoom();
    
    elements.interactiveUpload.style.display = 'none';
    elements.interactivePreview.style.display = 'block';
}

// 处理 Canvas 点击
function handleCanvasClick(e, label) {
    const point = getCanvasPointFromEvent(e);
    if (!point) return;
    const [x, y] = point;
    if (x < 0 || y < 0 || x > elements.interactiveCanvas.width || y > elements.interactiveCanvas.height) {
        return;
    }
    
    state.interactivePoints.push([x, y]);
    state.interactiveLabels.push(label);
    
    // 绘制点
    const ctx = elements.interactiveCanvas.getContext('2d');
    ctx.beginPath();
    ctx.arc(x, y, 5 / state.zoom, 0, 2 * Math.PI);
    ctx.fillStyle = label === 1 ? '#28a745' : '#dc3545';
    ctx.fill();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2 / state.zoom;
    ctx.stroke();
}

// 重绘 Canvas
async function redrawCanvas() {
    if (!state.currentImage) return;
    
    const img = await loadPreviewImageElement(state.currentImage, '交互画布原图');
    if (!img) {
        return;
    }
    const ctx = elements.interactiveCanvas.getContext('2d');
    ctx.clearRect(0, 0, elements.interactiveCanvas.width, elements.interactiveCanvas.height);
    ctx.drawImage(img, 0, 0);
    
    // 重绘所有点
    state.interactivePoints.forEach((point, i) => {
        const label = state.interactiveLabels[i];
        ctx.beginPath();
        ctx.arc(point[0], point[1], 5 / state.zoom, 0, 2 * Math.PI);
        ctx.fillStyle = label === 1 ? '#28a745' : '#dc3545';
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2 / state.zoom;
        ctx.stroke();
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// 更新缩放
function updateZoom() {
    const view = state.interactiveView;
    elements.interactiveCanvas.style.transformOrigin = 'top left';
    elements.interactiveCanvas.style.transform =
        `translate(${view.offsetX}px, ${view.offsetY}px) scale(${state.zoom})`;
    elements.zoomLevel.textContent = Math.round(state.zoom * 100) + '%';
    state.interactiveOptions.localZoom = Math.max(1, Math.min(4, state.zoom));
    if (elements.interactiveLocalZoom) {
        elements.interactiveLocalZoom.value = String(state.interactiveOptions.localZoom);
    }
    setTextContent(
        elements.interactiveLocalZoomValue,
        `${Math.round(state.interactiveOptions.localZoom * 100)}%`
    );
}

// ========== 批量模式 ==========
function initBatchMode() {
    // 选择输入文件夹
    elements.batchInputBtn.addEventListener('click', async () => {
        const selected = await open({
            directory: true,
            multiple: false
        });
        if (selected) {
            elements.batchInput.value = selected;
            checkBatchReady();
        }
    });
    
    // 选择输出文件夹
    elements.batchOutputBtn.addEventListener('click', async () => {
        const selected = await open({
            directory: true,
            multiple: false
        });
        if (selected) {
            elements.batchOutput.value = selected;
            checkBatchReady();
        }
    });
    
    // 开始批量处理
    elements.batchStart.addEventListener('click', async () => {
        if (!(await ensureModelReady('批量处理'))) {
            return;
        }
        
        const inputDir = elements.batchInput.value;
        const outputDir = elements.batchOutput.value;
        
        elements.batchProgress.style.display = 'block';
        elements.progressText.textContent = '任务已创建';
        elements.progressPercent.textContent = '0%';
        elements.progressFill.style.width = '0%';

        createTask({
            title: `批量抠图 · ${getBaseName(inputDir) || '目录'}`,
            inputPath: '',
            outputPath: '',
            taskMeta: {
                type: 'batch',
            },
            execute: async () => {
                const results = await invoke('batch_process', {
                    inputDir: inputDir,
                    outputDir: outputDir
                });
                return {
                    success: true,
                    message: `批量完成，共 ${Array.isArray(results) ? results.length : 0} 项`,
                    batchResults: Array.isArray(results) ? results : []
                };
            },
            onSuccess: async (result) => {
                const list = Array.isArray(result?.batchResults) ? result.batchResults : [];
                displayBatchResults(list);
            }
        });
        showSamNotice('已创建批量任务，等待队列执行', 'success', 2200);
    });
}

// 检查批量处理是否就绪
function checkBatchReady() {
    elements.batchStart.disabled = !(elements.batchInput.value && elements.batchOutput.value);
}

// 显示批量处理结果
function displayBatchResults(results) {
    elements.resultsGrid.innerHTML = '';
    
    let successCount = 0;
    results.forEach(result => {
        if (result.success) successCount++;
        
        const item = document.createElement('div');
        item.className = 'result-item';
        item.innerHTML = `
            <p class="filename">${result.input_path.split('/').pop()}</p>
            <p class="status ${result.success ? 'success' : 'error'}">
                ${result.success ? '✓ 成功' : '✗ 失败'}
            </p>
        `;
        elements.resultsGrid.appendChild(item);
    });
    
    elements.batchResults.style.display = 'block';
    elements.progressText.textContent = `${successCount}/${results.length}`;
    elements.progressFill.style.width = '100%';
    elements.progressPercent.textContent = '100%';
}

// ========== 设置 ==========
function initSettings() {
    // 加载可用模型列表
    loadModelList();
    
    // 代理设置
    loadProxyConfig();
    loadSamRuntimeConfig();
    
    // 测试代理
    elements.proxyTest.addEventListener('click', async () => {
        elements.proxyTestResult.textContent = '测试中...';
        elements.proxyTestResult.className = 'test-result testing';
        
        try {
            const result = await invoke('test_proxy_connection');
            elements.proxyTestResult.textContent = '✓ ' + result;
            elements.proxyTestResult.className = 'test-result success';
        } catch (e) {
            elements.proxyTestResult.textContent = '✗ ' + e;
            elements.proxyTestResult.className = 'test-result error';
        }
    });
    
    // 保存代理配置
    elements.proxySave.addEventListener('click', async () => {
        const config = {
            enabled: elements.proxyEnabled.checked,
            url: elements.proxyUrl.value,
            username: elements.proxyUsername.value || null,
            password: elements.proxyPassword.value || null,
        };
        
        try {
            await invoke('set_proxy_config', { config });
            alert('代理配置已保存！');
        } catch (e) {
            alert('保存失败: ' + e);
        }
    });
    
    // 选择模型路径
    elements.modelPathBtn.addEventListener('click', async () => {
        const selected = await open({
            filters: [{ name: 'Model', extensions: ['pth'] }],
            multiple: false
        });
        if (selected) {
            elements.modelPath.value = selected;
        }
    });

    if (elements.pythonPathBtn) {
        elements.pythonPathBtn.addEventListener('click', async () => {
            const selected = await open({
                multiple: false
            });
            if (!selected) return;
            const normalized = normalizeSinglePath(selected);
            if (normalized && elements.pythonPath) {
                elements.pythonPath.value = normalized;
            }
        });
    }

    if (elements.pythonPathSave) {
        elements.pythonPathSave.addEventListener('click', async () => {
            const pythonPath = elements.pythonPath?.value?.trim() || '';
            if (!pythonPath) {
                showSamNotice('请先选择 Python 可执行文件路径', 'warn', 2800);
                return;
            }

            try {
                const config = await invoke('set_sam_runtime_config', { pythonPath });
                const savedPath = config?.python_path || config?.pythonPath || pythonPath;
                if (elements.pythonPath) {
                    elements.pythonPath.value = savedPath;
                }
                showSamNotice('Python 路径已保存', 'success', 2400);
            } catch (e) {
                showSamNotice(`Python 路径保存失败: ${e}`, 'error', 4200);
            }
        });
    }

    if (elements.pythonDepsCheck) {
        elements.pythonDepsCheck.addEventListener('click', async () => {
            await runPythonDependencyCheck();
        });
    }
    
    // 加载模型
    elements.modelLoad.addEventListener('click', async () => {
        const modelPath = elements.modelPath.value;
        if (!modelPath) {
            alert('请选择模型文件');
            return;
        }
        
        showLoading('正在加载模型...');
        
        try {
            const result = await invoke('init_sam_model', { modelPath: modelPath });
            state.modelLoaded = true;
            updateModelStatus(true);
            showSamNotice('模型加载成功！', 'success', 2600);
        } catch (e) {
            showSamNotice(`模型加载失败: ${e}`, 'error', 5000);
            updateModelStatus(false);
        } finally {
            hideLoading();
        }
    });
    
    // 质量滑块
    elements.outputQuality.addEventListener('input', (e) => {
        elements.qualityValue.textContent = e.target.value + '%';
    });
}

async function loadSamRuntimeConfig() {
    try {
        const config = await invoke('get_sam_runtime_config');
        const pythonPath = config?.python_path || config?.pythonPath || '';
        if (elements.pythonPath) {
            elements.pythonPath.value = pythonPath;
        }
    } catch (e) {
        console.error('Failed to load SAM runtime config:', e);
    }
}

function setPythonDepsResult(message, statusClass = 'testing') {
    if (!elements.pythonDepsResult) return;
    elements.pythonDepsResult.style.display = 'block';
    elements.pythonDepsResult.className = `test-result ${statusClass}`;
    elements.pythonDepsResult.textContent = message;
}

function normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
}

async function runPythonDependencyCheck() {
    if (!elements.pythonDepsCheck) return;

    elements.pythonDepsCheck.disabled = true;
    setPythonDepsResult('检测中...', 'testing');

    try {
        const pythonPathInput = elements.pythonPath?.value?.trim() || '';
        if (pythonPathInput) {
            try {
                await invoke('set_sam_runtime_config', { pythonPath: pythonPathInput });
            } catch (syncError) {
                console.warn('Failed to sync python path before dependency check:', syncError);
            }
        }

        const result = await invoke('check_python_dependencies');
        const pythonPath = result?.python_path || result?.pythonPath || '';
        const pythonVersion = result?.python_version || result?.pythonVersion || '';
        const installed = normalizeStringArray(result?.installed);
        const missingRequired = normalizeStringArray(result?.missing_required || result?.missingRequired);
        const missingOptional = normalizeStringArray(result?.missing_optional || result?.missingOptional);
        const warning = typeof result?.warning === 'string' ? result.warning.trim() : '';

        if (elements.pythonPath && pythonPath) {
            elements.pythonPath.value = pythonPath;
        }

        const lines = [];
        if (pythonPath) lines.push(`Python: ${pythonPath}`);
        if (pythonVersion) lines.push(`版本: ${pythonVersion}`);
        lines.push(`已安装核心依赖: ${installed.length > 0 ? installed.join(', ') : '无'}`);

        if (missingRequired.length > 0) {
            lines.push(`缺少核心依赖: ${missingRequired.join(', ')}`);
            lines.push(`建议安装: pip install ${missingRequired.join(' ')}`);
            setPythonDepsResult(lines.join('\n'), 'error');
            return;
        }

        if (missingOptional.length > 0) {
            lines.push(`缺少可选依赖: ${missingOptional.join(', ')}`);
        }
        if (warning) {
            lines.push(`提示: ${warning}`);
        }

        setPythonDepsResult(lines.join('\n'), 'success');
    } catch (e) {
        setPythonDepsResult(`检测失败: ${e}`, 'error');
    } finally {
        elements.pythonDepsCheck.disabled = false;
    }
}

// 加载模型列表
async function loadModelList() {
    const modelList = document.getElementById('model-list');
    if (!modelList) return;
    
    try {
        const models = await invoke('get_available_models');
        
        modelList.innerHTML = models.map(model => `
            <div class="model-item ${model.recommended ? 'recommended' : ''}" data-model="${model.name}">
                <div class="model-info">
                    <h4>${model.name}</h4>
                    <p>${model.description}</p>
                    <span class="model-size">${formatBytes(model.size)}</span>
                    ${model.recommended ? '<span class="recommended-badge">推荐</span>' : ''}
                </div>
                <div class="model-actions">
                    <button class="btn-download" onclick="downloadModel('${model.name}')">
                        ⬇️ 下载
                    </button>
                    <span class="download-status" id="status-${model.name}"></span>
                </div>
            </div>
        `).join('');
        
        // 检查已下载的模型
        for (const model of models) {
            checkDownloadedModelStatus(model.name);
        }
    } catch (e) {
        console.error('Failed to load model list:', e);
    }
}

// 检查模型状态
async function checkDownloadedModelStatus(modelName) {
    try {
        const downloaded = await invoke('check_model_downloaded', { modelName });
        const statusEl = document.getElementById(`status-${modelName}`);
        const btnEl = document.querySelector(`[data-model="${modelName}"] .btn-download`);
        
        if (statusEl && downloaded) {
            statusEl.textContent = '✓ 已下载';
            statusEl.className = 'download-status downloaded';
            if (btnEl) btnEl.textContent = '🔄 重新下载';
            
            // 自动设置模型路径
            const path = await invoke('get_model_path', { modelName });
            if (elements.modelPath) elements.modelPath.value = path;
        }
    } catch (e) {
        console.error('Failed to check model status:', e);
    }
}

// 下载模型
async function downloadModel(modelName) {
    const progressContainer = document.getElementById('download-progress-container');
    const progressEl = document.getElementById('model-download-progress');
    const statusEl = document.getElementById('download-status');
    const speedEl = document.getElementById('download-speed');
    const etaEl = document.getElementById('download-eta');
    const btnEl = document.querySelector(`[data-model="${modelName}"] .btn-download`);
    
    if (progressContainer) progressContainer.style.display = 'block';
    if (btnEl) {
        btnEl.disabled = true;
        btnEl.textContent = '下载中...';
    }
    
    // 监听进度事件
    let unlisten = null;
    if (window.tauriEvent) {
        unlisten = await window.tauriEvent.listen('download-progress', (event) => {
            const progress = event.payload;
            if (progressEl) progressEl.style.width = progress.percent + '%';
            if (statusEl) statusEl.textContent = `${progress.percent}% (${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)})`;
            if (speedEl) speedEl.textContent = formatSpeed(progress.speed);
            if (etaEl) etaEl.textContent = formatETA(progress.eta_seconds);
        });
    }
    
    try {
        const path = await invoke('download_model', { modelName });
        if (statusEl) statusEl.textContent = '✓ 下载完成！';
        await checkDownloadedModelStatus(modelName);
        alert('模型下载成功！');
    } catch (e) {
        if (statusEl) statusEl.textContent = '✗ 下载失败: ' + e;
        if (btnEl) btnEl.textContent = '⬇️ 重试';
    } finally {
        if (btnEl) btnEl.disabled = false;
        if (unlisten) unlisten();
        setTimeout(() => {
            if (progressContainer) progressContainer.style.display = 'none';
        }, 3000);
    }
}

// 加载代理配置
async function loadProxyConfig() {
    try {
        const config = await invoke('get_proxy_config');
        if (elements.proxyEnabled) elements.proxyEnabled.checked = config.enabled;
        if (elements.proxyUrl) elements.proxyUrl.value = config.url || '';
        if (elements.proxyUsername) elements.proxyUsername.value = config.username || '';
        if (elements.proxyPassword) elements.proxyPassword.value = config.password || '';
    } catch (e) {
        console.error('Failed to load proxy config:', e);
    }
}

// 更新模型状态显示
function updateModelStatus(loaded) {
    if (!elements.modelStatus) return;
    
    if (loaded) {
        elements.modelStatus.textContent = '已加载';
        elements.modelStatus.className = 'status loaded';
    } else {
        elements.modelStatus.textContent = '未加载';
        elements.modelStatus.className = 'status error';
    }
}

// 检查模型状态
async function checkSamModelLoaded() {
    try {
        const loaded = await invoke('is_model_loaded');
        state.modelLoaded = loaded;
        updateModelStatus(loaded);
    } catch (e) {
        console.error('Failed to check model status:', e);
    }
}

function isRenderablePreviewUrl(value) {
    if (typeof value !== 'string') return false;
    const text = value.trim();
    if (!text) return false;
    if (text.startsWith('data:')) return true;
    // Accept only explicit URL schemes, reject plain absolute file paths like /Users/...
    return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(text);
}

// 获取图片预览
async function getImagePreview(imagePath) {
    const path = typeof imagePath === 'string' ? imagePath.trim() : '';
    if (!path) {
        return '';
    }

    // Prefer backend base64 preview to avoid unsupported absolute local paths on WebView.
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const fallback = await invoke('get_image_preview', { imagePath: path });
            if (typeof fallback === 'string' && fallback.startsWith('data:image/')) {
                return fallback;
            }
            if (isRenderablePreviewUrl(fallback) && !fallback.startsWith('/')) {
                return fallback;
            }
            console.warn('[preview] fallback returned non-renderable value:', {
                sourcePath: path,
                returned: fallback,
                attempt: attempt + 1
            });
        } catch (e) {
            console.warn('[preview] get_image_preview failed, retry or fallback:', {
                sourcePath: path,
                attempt: attempt + 1,
                error: e instanceof Error ? e.message : String(e)
            });
            if (attempt < 2) {
                await sleep(120 * (attempt + 1));
            }
        }
    }

    const convert = window.tauriCore?.convertFileSrc;
    if (typeof convert === 'function') {
        try {
            const maybeUrl = await convert(path);
            if (isRenderablePreviewUrl(maybeUrl) && !maybeUrl.startsWith('/')) {
                return maybeUrl;
            }
            console.warn('[preview] convertFileSrc returned unsupported value:', {
                sourcePath: path,
                returned: maybeUrl
            });
        } catch (error) {
            console.warn('[preview] convertFileSrc failed:', {
                sourcePath: path,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    return '';
}

async function setPreviewImageSrc(imageElement, imagePath, contextLabel = '图片') {
    if (!imageElement) {
        return '';
    }
    const previewUrl = await getImagePreview(imagePath);
    if (!isRenderablePreviewUrl(previewUrl)) {
        imageElement.removeAttribute('src');
        console.error(`[preview] invalid url for ${contextLabel}:`, previewUrl);
        showSamNotice(`${contextLabel}预览失败：资源地址不受支持`, 'error', 4200);
        return '';
    }
    imageElement.src = previewUrl;
    return previewUrl;
}

async function loadPreviewImageElement(imagePath, contextLabel = '图片') {
    const previewUrl = await getImagePreview(imagePath);
    if (!isRenderablePreviewUrl(previewUrl)) {
        console.error(`[preview] invalid url for ${contextLabel}:`, previewUrl);
        showSamNotice(`${contextLabel}预览失败：资源地址不受支持`, 'error', 4200);
        return null;
    }

    const image = new Image();
    try {
        await new Promise((resolve, reject) => {
            let settled = false;
            const done = (callback) => {
                if (settled) return;
                settled = true;
                callback();
            };
            image.onload = () => done(resolve);
            image.onerror = () => done(() => reject(new Error(`${contextLabel}图片加载失败`)));
            image.src = previewUrl;
            if (image.complete && image.naturalWidth > 0) {
                done(resolve);
            }
        });
        return image;
    } catch (error) {
        console.error(`[preview] failed to load image element for ${contextLabel}:`, error);
        showSamNotice(`${contextLabel}预览失败：图片加载失败`, 'error', 4200);
        return null;
    }
}

// 显示加载遮罩
function showLoading(text) {
    if (elements.loadingText) elements.loadingText.textContent = text;
    if (elements.loadingOverlay) elements.loadingOverlay.style.display = 'flex';
}

// 隐藏加载遮罩
function hideLoading() {
    if (elements.loadingOverlay) elements.loadingOverlay.style.display = 'none';
}

// 格式化字节
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 格式化速度
function formatSpeed(bytesPerSecond) {
    if (bytesPerSecond === 0) return '';
    return formatBytes(bytesPerSecond) + '/s';
}

// 格式化 ETA
function formatETA(seconds) {
    if (seconds === 0) return '';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// 使 downloadModel 全局可用
window.downloadModel = downloadModel;
