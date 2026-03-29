use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SegmentationResult {
    pub input_path: String,
    pub output_path: String,
    pub success: bool,
    pub message: String,
    pub width: u32,
    pub height: u32,
}

pub struct SamProcessor {
    model_path: String,
    worker: Mutex<Option<SamWorkerProcess>>,
}

struct SamWorkerProcess {
    python_executable: String,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    processed_requests: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AutoSegmentationOptions {
    pub method: Option<String>,
    pub select_mode: Option<String>,
    pub points_per_side: Option<u32>,
    pub pred_iou_thresh: Option<f32>,
    pub stability_score_thresh: Option<f32>,
    pub min_mask_region_area: Option<u32>,
    pub smooth_radius: Option<f32>,
    pub alpha_threshold: Option<u8>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct InteractiveSegmentationOptions {
    pub select_mode: Option<String>,
    pub smooth_radius: Option<f32>,
    pub alpha_threshold: Option<u8>,
}

impl Default for AutoSegmentationOptions {
    fn default() -> Self {
        Self {
            method: Some("center_point".to_string()),
            select_mode: Some("best_score".to_string()),
            points_per_side: Some(32),
            pred_iou_thresh: Some(0.86),
            stability_score_thresh: Some(0.92),
            min_mask_region_area: Some(120),
            smooth_radius: Some(1.2),
            alpha_threshold: Some(12),
        }
    }
}

fn clamp_f32(value: f32, min: f32, max: f32) -> f32 {
    value.max(min).min(max)
}

fn clamp_u32(value: u32, min: u32, max: u32) -> u32 {
    value.max(min).min(max)
}

impl AutoSegmentationOptions {
    pub fn normalized(input: Option<&AutoSegmentationOptions>) -> AutoSegmentationOptions {
        let defaults = AutoSegmentationOptions::default();
        let mut options = input.cloned().unwrap_or_else(|| defaults.clone());

        let method = options
            .method
            .clone()
            .unwrap_or_else(|| defaults.method.clone().unwrap_or_else(|| "center_point".to_string()))
            .to_lowercase();
        options.method = Some(if method == "auto_generator" {
            "auto_generator".to_string()
        } else {
            "center_point".to_string()
        });

        let select_mode = options
            .select_mode
            .clone()
            .unwrap_or_else(|| defaults.select_mode.clone().unwrap_or_else(|| "best_score".to_string()))
            .to_lowercase();
        options.select_mode = Some(if select_mode == "largest_area" {
            "largest_area".to_string()
        } else {
            "best_score".to_string()
        });

        options.points_per_side = Some(clamp_u32(
            options.points_per_side.unwrap_or(defaults.points_per_side.unwrap_or(32)),
            8,
            96,
        ));
        options.pred_iou_thresh = Some(clamp_f32(
            options.pred_iou_thresh.unwrap_or(defaults.pred_iou_thresh.unwrap_or(0.86)),
            0.10,
            0.99,
        ));
        options.stability_score_thresh = Some(clamp_f32(
            options
                .stability_score_thresh
                .unwrap_or(defaults.stability_score_thresh.unwrap_or(0.92)),
            0.10,
            0.99,
        ));
        options.min_mask_region_area = Some(clamp_u32(
            options
                .min_mask_region_area
                .unwrap_or(defaults.min_mask_region_area.unwrap_or(120)),
            0,
            100000,
        ));
        options.smooth_radius = Some(clamp_f32(
            options.smooth_radius.unwrap_or(defaults.smooth_radius.unwrap_or(1.2)),
            0.0,
            12.0,
        ));
        options.alpha_threshold = Some(
            options
                .alpha_threshold
                .unwrap_or(defaults.alpha_threshold.unwrap_or(12))
                .min(200),
        );

        options
    }
}

impl Default for InteractiveSegmentationOptions {
    fn default() -> Self {
        Self {
            select_mode: Some("best_score".to_string()),
            smooth_radius: Some(0.6),
            alpha_threshold: Some(6),
        }
    }
}

impl InteractiveSegmentationOptions {
    pub fn normalized(input: Option<&InteractiveSegmentationOptions>) -> InteractiveSegmentationOptions {
        let defaults = InteractiveSegmentationOptions::default();
        let mut options = input.cloned().unwrap_or_else(|| defaults.clone());

        let select_mode = options
            .select_mode
            .clone()
            .unwrap_or_else(|| defaults.select_mode.clone().unwrap_or_else(|| "best_score".to_string()))
            .to_lowercase();
        options.select_mode = Some(if select_mode == "largest_area" {
            "largest_area".to_string()
        } else if select_mode == "smallest_area" {
            "smallest_area".to_string()
        } else {
            "best_score".to_string()
        });

        options.smooth_radius = Some(clamp_f32(
            options.smooth_radius.unwrap_or(defaults.smooth_radius.unwrap_or(0.6)),
            0.0,
            12.0,
        ));
        options.alpha_threshold = Some(
            options
                .alpha_threshold
                .unwrap_or(defaults.alpha_threshold.unwrap_or(6))
                .min(200),
        );

        options
    }
}

const SAM_RUNNER_SCRIPT: &str = r#"
import json
import os
import traceback
import sys
from PIL import Image, ImageFilter
import numpy as np
from segment_anything import sam_model_registry, SamPredictor, SamAutomaticMaskGenerator

MODEL_CACHE = {}

def clamp(v, min_v, max_v):
    return max(min_v, min(v, max_v))

def normalize_options(opts):
    opts = opts or {}
    method = str(opts.get("method", "center_point")).lower()
    if method not in ("center_point", "auto_generator"):
        method = "center_point"

    select_mode = str(opts.get("select_mode", "best_score")).lower()
    if select_mode not in ("best_score", "largest_area"):
        select_mode = "best_score"

    return {
        "method": method,
        "select_mode": select_mode,
        "points_per_side": int(clamp(int(opts.get("points_per_side", 32)), 8, 96)),
        "pred_iou_thresh": float(clamp(float(opts.get("pred_iou_thresh", 0.86)), 0.10, 0.99)),
        "stability_score_thresh": float(clamp(float(opts.get("stability_score_thresh", 0.92)), 0.10, 0.99)),
        "min_mask_region_area": int(clamp(int(opts.get("min_mask_region_area", 120)), 0, 100000)),
        "smooth_radius": float(clamp(float(opts.get("smooth_radius", 1.2)), 0.0, 12.0)),
        "alpha_threshold": int(clamp(int(opts.get("alpha_threshold", 12)), 0, 200)),
    }

def pick_mask_with_auto_generator(image_np, sam_model, options):
    mask_generator = SamAutomaticMaskGenerator(
        model=sam_model,
        points_per_side=options["points_per_side"],
        pred_iou_thresh=options["pred_iou_thresh"],
        stability_score_thresh=options["stability_score_thresh"],
        min_mask_region_area=options["min_mask_region_area"],
    )
    generated = mask_generator.generate(image_np)
    if not generated:
        raise RuntimeError("No masks generated for image")
    if options["select_mode"] == "largest_area":
        selected = max(generated, key=lambda m: float(m.get("area", 0.0)))
    else:
        selected = max(generated, key=lambda m: float(m.get("predicted_iou", 0.0)))
    return selected["segmentation"]

def pick_mask_with_center_point(image_np, predictor, options):
    h, w = image_np.shape[:2]
    center_point = np.array([[w / 2.0, h / 2.0]], dtype=np.float32)
    point_labels = np.array([1], dtype=np.int32)
    masks, scores, _ = predictor.predict(
        point_coords=center_point,
        point_labels=point_labels,
        box=None,
        multimask_output=True,
    )
    if options["select_mode"] == "largest_area":
        areas = masks.reshape(masks.shape[0], -1).sum(axis=1)
        return masks[np.argmax(areas)]
    return masks[np.argmax(scores)]

def apply_mask_to_image(image_np, mask, options, output_path):
    alpha = (mask.astype(np.uint8) * 255)
    if options["smooth_radius"] > 0:
        alpha_img = Image.fromarray(alpha, mode="L")
        alpha_img = alpha_img.filter(ImageFilter.GaussianBlur(radius=options["smooth_radius"]))
        alpha = np.array(alpha_img)
    if options["alpha_threshold"] > 0:
        alpha = np.where(alpha >= options["alpha_threshold"], alpha, 0).astype(np.uint8)

    h, w = image_np.shape[:2]
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[:, :, :3] = image_np
    rgba[:, :, 3] = alpha
    Image.fromarray(rgba).save(output_path)
    return w, h

def run_auto(payload, predictor, sam_model):
    input_path = payload["input_path"]
    output_path = payload["output_path"]
    options = normalize_options(payload.get("options"))

    image = Image.open(input_path).convert("RGB")
    image_np = np.array(image)
    predictor.set_image(image_np)

    if options["method"] == "auto_generator":
        mask = pick_mask_with_auto_generator(image_np, sam_model, options)
    else:
        mask = pick_mask_with_center_point(image_np, predictor, options)

    width, height = apply_mask_to_image(image_np, mask, options, output_path)
    return {
        "input_path": input_path,
        "output_path": output_path,
        "success": True,
        "message": "Auto segmentation completed",
        "width": int(width),
        "height": int(height),
    }

def run_interactive(payload, predictor):
    input_path = payload["input_path"]
    output_path = payload["output_path"]
    points = payload.get("points", [])
    labels = payload.get("labels", [])
    options = payload.get("options", {}) or {}
    select_mode = str(options.get("select_mode", "best_score")).lower()
    if select_mode not in ("best_score", "largest_area", "smallest_area"):
        select_mode = "best_score"
    smooth_radius = float(clamp(float(options.get("smooth_radius", 0.6)), 0.0, 12.0))
    alpha_threshold = int(clamp(int(options.get("alpha_threshold", 6)), 0, 200))

    image = Image.open(input_path).convert("RGB")
    image_np = np.array(image)
    predictor.set_image(image_np)

    point_coords = np.array(points, dtype=np.float32)
    point_labels = np.array(labels, dtype=np.int32)
    masks, scores, _ = predictor.predict(
        point_coords=point_coords,
        point_labels=point_labels,
        multimask_output=True,
    )
    if select_mode == "largest_area":
        areas = masks.reshape(masks.shape[0], -1).sum(axis=1)
        mask = masks[np.argmax(areas)]
    elif select_mode == "smallest_area":
        areas = masks.reshape(masks.shape[0], -1).sum(axis=1)
        mask = masks[np.argmin(areas)]
    else:
        mask = masks[np.argmax(scores)]

    apply_options = {
        "smooth_radius": smooth_radius,
        "alpha_threshold": alpha_threshold,
    }
    width, height = apply_mask_to_image(image_np, mask, apply_options, output_path)
    return {
        "input_path": input_path,
        "output_path": output_path,
        "success": True,
        "message": "Interactive segmentation completed",
        "width": int(width),
        "height": int(height),
    }

def run_batch(payload, predictor, sam_model):
    input_dir = payload["input_dir"]
    output_dir = payload["output_dir"]
    options = normalize_options(payload.get("options"))

    os.makedirs(output_dir, exist_ok=True)
    extensions = {"png", "jpg", "jpeg", "bmp", "tiff", "webp"}
    results = []

    for file_name in sorted(os.listdir(input_dir)):
        src = os.path.join(input_dir, file_name)
        if not os.path.isfile(src):
            continue
        ext = os.path.splitext(file_name)[1].lower().lstrip(".")
        if ext not in extensions:
            continue

        stem, _ = os.path.splitext(file_name)
        dst = os.path.join(output_dir, f"{stem}_no_bg.png")
        try:
            entry_payload = {
                "input_path": src,
                "output_path": dst,
                "options": options,
            }
            entry_result = run_auto(entry_payload, predictor, sam_model)
            results.append(entry_result)
        except Exception as exc:
            results.append({
                "input_path": src,
                "output_path": dst,
                "success": False,
                "message": str(exc),
                "width": 0,
                "height": 0,
            })
    return results

def get_runtime(model_path, model_type, device):
    cache_key = f"{model_path}::{model_type}::{device}"
    runtime = MODEL_CACHE.get(cache_key)
    if runtime is not None:
        return runtime["sam"], runtime["predictor"]

    sam = sam_model_registry[model_type](checkpoint=model_path)
    sam.to(device=device)
    predictor = SamPredictor(sam)
    MODEL_CACHE[cache_key] = {
        "sam": sam,
        "predictor": predictor,
    }
    return sam, predictor

def process_payload(payload):
    mode = payload.get("mode")
    model_path = payload.get("model_path")
    model_type = payload.get("model_type", "vit_h")
    device = payload.get("device", "cpu")

    if mode not in ("auto", "interactive", "batch"):
        raise RuntimeError(f"Unsupported mode: {mode}")
    if not model_path:
        raise RuntimeError("Missing model_path")

    sam, predictor = get_runtime(model_path, model_type, device)

    if mode == "auto":
        return run_auto(payload, predictor, sam)
    if mode == "interactive":
        return run_interactive(payload, predictor)
    return run_batch(payload, predictor, sam)

def run_worker():
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except Exception as exc:
            print(json.dumps({
                "ok": False,
                "error": f"Invalid payload: {exc}",
            }, ensure_ascii=False), flush=True)
            continue

        if payload.get("mode") == "shutdown":
            print(json.dumps({
                "ok": True,
                "result": { "message": "worker shutdown" },
            }, ensure_ascii=False), flush=True)
            break

        try:
            result = process_payload(payload)
            print(json.dumps({
                "ok": True,
                "result": result,
            }, ensure_ascii=False), flush=True)
        except Exception as exc:
            print(json.dumps({
                "ok": False,
                "error": str(exc),
                "traceback": traceback.format_exc(),
            }, ensure_ascii=False), flush=True)

if __name__ == "__main__":
    run_worker()
"#;

const WORKER_MAX_REQUESTS_BEFORE_RESTART: u64 = 24;
const WORKER_MAX_NON_JSON_LINES: usize = 128;

fn parse_worker_json_line(line: &str) -> Result<Value, String> {
    serde_json::from_str::<Value>(line).map_err(|err| {
        format!("Invalid worker JSON line: {}; content: {}", err, line)
    })
}

fn shutdown_worker_process(worker_slot: &mut Option<SamWorkerProcess>) {
    let Some(mut worker) = worker_slot.take() else {
        return;
    };

    let shutdown_line = json!({ "mode": "shutdown" }).to_string();
    let _ = worker.stdin.write_all(shutdown_line.as_bytes());
    let _ = worker.stdin.write_all(b"\n");
    let _ = worker.stdin.flush();

    match worker.child.try_wait() {
        Ok(Some(_)) => {}
        Ok(None) => {
            let _ = worker.child.kill();
            let _ = worker.child.wait();
        }
        Err(_) => {}
    }
}

impl SamProcessor {
    pub fn new(model_path: &str) -> Result<Self, String> {
        if !Path::new(model_path).exists() {
            return Err(format!("Model file not found: {}", model_path));
        }
        Ok(Self {
            model_path: model_path.to_string(),
            worker: Mutex::new(None),
        })
    }

    fn spawn_worker_process(&self, python_executable: &str) -> Result<SamWorkerProcess, String> {
        let mut child = Command::new(python_executable)
            .arg("-u")
            .arg("-c")
            .arg(SAM_RUNNER_SCRIPT)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Failed to start SAM worker with '{}': {}", python_executable, e))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open SAM worker stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to open SAM worker stdout".to_string())?;

        Ok(SamWorkerProcess {
            python_executable: python_executable.to_string(),
            child,
            stdin,
            stdout: BufReader::new(stdout),
            processed_requests: 0,
        })
    }

    fn send_payload_to_worker(worker: &mut SamWorkerProcess, payload: &Value) -> Result<Value, String> {
        if let Some(status) = worker
            .child
            .try_wait()
            .map_err(|e| format!("Failed to query SAM worker status: {}", e))?
        {
            return Err(format!("SAM worker exited unexpectedly: {}", status));
        }

        let line = payload.to_string();
        worker
            .stdin
            .write_all(line.as_bytes())
            .map_err(|e| format!("Failed to write payload to SAM worker: {}", e))?;
        worker
            .stdin
            .write_all(b"\n")
            .map_err(|e| format!("Failed to write payload delimiter: {}", e))?;
        worker
            .stdin
            .flush()
            .map_err(|e| format!("Failed to flush payload to SAM worker: {}", e))?;

        let mut buffer = String::new();
        let mut non_json_lines = 0usize;
        loop {
            buffer.clear();
            let read = worker
                .stdout
                .read_line(&mut buffer)
                .map_err(|e| format!("Failed to read SAM worker output: {}", e))?;
            if read == 0 {
                return Err("SAM worker stdout closed unexpectedly".to_string());
            }

            let trimmed = buffer.trim();
            if trimmed.is_empty() {
                continue;
            }

            match parse_worker_json_line(trimmed) {
                Ok(value) => return Ok(value),
                Err(_) => {
                    non_json_lines += 1;
                    if non_json_lines >= WORKER_MAX_NON_JSON_LINES {
                        return Err(format!(
                            "SAM worker output exceeded non-JSON limit; last line: {}",
                            trimmed
                        ));
                    }
                }
            }
        }
    }

    fn run_python_with_payload(
        &self,
        python_executable: &str,
        payload: &Value,
    ) -> Result<Value, String> {
        let mut worker_slot = self
            .worker
            .lock()
            .map_err(|e| format!("Failed to lock SAM worker state: {}", e))?;

        for attempt in 0..=1 {
            if worker_slot
                .as_ref()
                .map(|worker| worker.python_executable != python_executable)
                .unwrap_or(false)
            {
                shutdown_worker_process(&mut worker_slot);
            }

            if worker_slot.is_none() {
                *worker_slot = Some(self.spawn_worker_process(python_executable)?);
            }

            let response = {
                let worker = worker_slot.as_mut().expect("worker is initialized");
                Self::send_payload_to_worker(worker, payload)
            };

            match response {
                Ok(response_json) => {
                    if let Some(worker) = worker_slot.as_mut() {
                        worker.processed_requests = worker.processed_requests.saturating_add(1);
                        if worker.processed_requests >= WORKER_MAX_REQUESTS_BEFORE_RESTART {
                            shutdown_worker_process(&mut worker_slot);
                        }
                    }

                    let ok = response_json
                        .get("ok")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    if !ok {
                        let error = response_json
                            .get("error")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Segmentation failed");
                        let traceback = response_json
                            .get("traceback")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        if traceback.is_empty() {
                            return Err(error.to_string());
                        }
                        return Err(format!("{}; traceback: {}", error, traceback));
                    }

                    return Ok(response_json.get("result").cloned().unwrap_or(Value::Null));
                }
                Err(err) => {
                    shutdown_worker_process(&mut worker_slot);
                    if attempt == 0 {
                        continue;
                    }
                    return Err(err);
                }
            }
        }

        Err("SAM worker unavailable".to_string())
    }

    pub fn auto_segment(
        &self,
        python_executable: &str,
        input_path: &str,
        output_path: &str,
        options: Option<&AutoSegmentationOptions>,
    ) -> Result<SegmentationResult, String> {
        let normalized = AutoSegmentationOptions::normalized(options);
        let payload = json!({
            "mode": "auto",
            "model_path": self.model_path,
            "model_type": "vit_h",
            "device": "cpu",
            "input_path": input_path,
            "output_path": output_path,
            "options": normalized,
        });
        let result = self.run_python_with_payload(python_executable, &payload)?;

        Ok(SegmentationResult {
            input_path: result
                .get("input_path")
                .and_then(|v| v.as_str())
                .unwrap_or(input_path)
                .to_string(),
            output_path: result
                .get("output_path")
                .and_then(|v| v.as_str())
                .unwrap_or(output_path)
                .to_string(),
            success: result.get("success").and_then(|v| v.as_bool()).unwrap_or(true),
            message: result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Auto segmentation completed")
                .to_string(),
            width: result.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            height: result.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        })
    }

    pub fn interactive_segment(
        &self,
        python_executable: &str,
        input_path: &str,
        output_path: &str,
        points: &[(f32, f32)],
        labels: &[i32],
        options: Option<&InteractiveSegmentationOptions>,
    ) -> Result<SegmentationResult, String> {
        let points_vec: Vec<[f32; 2]> = points.iter().map(|(x, y)| [*x, *y]).collect();
        let normalized = InteractiveSegmentationOptions::normalized(options);
        let payload = json!({
            "mode": "interactive",
            "model_path": self.model_path,
            "model_type": "vit_h",
            "device": "cpu",
            "input_path": input_path,
            "output_path": output_path,
            "points": points_vec,
            "labels": labels,
            "options": normalized,
        });
        let result = self.run_python_with_payload(python_executable, &payload)?;

        Ok(SegmentationResult {
            input_path: result
                .get("input_path")
                .and_then(|v| v.as_str())
                .unwrap_or(input_path)
                .to_string(),
            output_path: result
                .get("output_path")
                .and_then(|v| v.as_str())
                .unwrap_or(output_path)
                .to_string(),
            success: result.get("success").and_then(|v| v.as_bool()).unwrap_or(true),
            message: result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Interactive segmentation completed")
                .to_string(),
            width: result.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            height: result.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        })
    }

    pub fn batch_process(
        &self,
        python_executable: &str,
        input_dir: &str,
        output_dir: &str,
    ) -> Result<Vec<SegmentationResult>, String> {
        let payload = json!({
            "mode": "batch",
            "model_path": self.model_path,
            "model_type": "vit_h",
            "device": "cpu",
            "input_dir": input_dir,
            "output_dir": output_dir,
            "options": AutoSegmentationOptions::default(),
        });

        let result = self.run_python_with_payload(python_executable, &payload)?;
        let Some(items) = result.as_array() else {
            return Err("Batch process returned invalid result".to_string());
        };

        let mut parsed = Vec::new();
        for item in items {
            let row: SegmentationResult = serde_json::from_value(item.clone())
                .map_err(|e| format!("Failed to parse batch entry: {}", e))?;
            parsed.push(row);
        }
        Ok(parsed)
    }
}

impl Drop for SamProcessor {
    fn drop(&mut self) {
        if let Ok(mut worker_slot) = self.worker.lock() {
            shutdown_worker_process(&mut worker_slot);
        }
    }
}
