use reqwest::{Client, Proxy, header};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use serde::{Deserialize, Serialize};
use tokio::time::{sleep, Duration};
use futures_util::StreamExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyConfig {
    pub enabled: bool,
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            url: String::new(),
            username: None,
            password: None,
        }
    }
}

impl ProxyConfig {
    pub fn from_env() -> Option<Self> {
        let proxy_url = std::env::var("HTTPS_PROXY")
            .or_else(|_| std::env::var("https_proxy"))
            .or_else(|_| std::env::var("HTTP_PROXY"))
            .or_else(|_| std::env::var("http_proxy"))
            .ok()?;
        
        Some(Self {
            enabled: true,
            url: proxy_url,
            username: None,
            password: None,
        })
    }
    
    pub fn to_reqwest_proxy(&self) -> Result<Proxy, String> {
        if !self.enabled || self.url.is_empty() {
            return Err("Proxy not enabled".to_string());
        }
        
        let mut proxy = Proxy::all(&self.url)
            .map_err(|e| format!("Invalid proxy URL: {}", e))?;
        
        if let (Some(username), Some(password)) = (&self.username, &self.password) {
            proxy = proxy.basic_auth(username, password);
        }
        
        Ok(proxy)
    }
}

#[derive(Debug, Clone)]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
    pub speed: f64,
    pub eta_seconds: u64,
}

pub struct Downloader {
    client: Client,
    proxy_config: Option<ProxyConfig>,
    chunk_size: usize,
    max_retries: u32,
}

impl Downloader {
    pub fn new(proxy_config: Option<ProxyConfig>) -> Result<Self, reqwest::Error> {
        let mut client_builder = Client::builder()
            .timeout(Duration::from_secs(300))
            .connect_timeout(Duration::from_secs(30));
        
        if let Some(ref config) = proxy_config {
            if config.enabled {
                match config.to_reqwest_proxy() {
                    Ok(proxy) => {
                        client_builder = client_builder.proxy(proxy);
                    }
                    Err(e) => {
                        eprintln!("Warning: Failed to set proxy: {}", e);
                    }
                }
            }
        }
        
        let client = client_builder.build()?;
        
        Ok(Self {
            client,
            proxy_config,
            chunk_size: 8192,
            max_retries: 3,
        })
    }
    
    pub async fn get_file_size(&self, url: &str) -> Result<u64, String> {
        let response = self.client
            .head(url)
            .send()
            .await
            .map_err(|e| format!("Failed to get file info: {}", e))?;
        
        if !response.status().is_success() {
            return Err(format!("HTTP error: {}", response.status()));
        }
        
        response
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| "Content-Length not available".to_string())
    }
    
    pub async fn supports_resume(&self, url: &str) -> Result<bool, String> {
        let response = self.client
            .head(url)
            .header(header::RANGE, "bytes=0-0")
            .send()
            .await
            .map_err(|e| format!("Failed to check resume support: {}", e))?;
        
        Ok(response.status() == reqwest::StatusCode::PARTIAL_CONTENT)
    }
    
    pub async fn download_with_resume<F>(
        &self,
        url: &str,
        save_path: &str,
        mut progress_callback: F,
    ) -> Result<(), String>
    where
        F: FnMut(DownloadProgress) + Send + Clone + 'static,
    {
        let _path = Path::new(save_path);
        let temp_path = format!("{}.tmp", save_path);
        
        let total_size = self.get_file_size(url).await?;
        let supports_resume = self.supports_resume(url).await.unwrap_or(false);
        
        let mut downloaded = if supports_resume && Path::new(&temp_path).exists() {
            fs::metadata(&temp_path)
                .map(|m| m.len())
                .unwrap_or(0)
        } else {
            0
        };
        
        if downloaded >= total_size && total_size > 0 {
            fs::rename(&temp_path, save_path)
                .map_err(|e| format!("Failed to rename file: {}", e))?;
            progress_callback(DownloadProgress {
                downloaded: total_size,
                total: total_size,
                speed: 0.0,
                eta_seconds: 0,
            });
            return Ok(());
        }
        
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&temp_path)
            .map_err(|e| format!("Failed to open file: {}", e))?;
        
        let mut request = self.client.get(url);
        if supports_resume && downloaded > 0 {
            request = request.header(
                header::RANGE,
                format!("bytes={}-", downloaded)
            );
        }
        
        let response = request
            .send()
            .await
            .map_err(|e| format!("Failed to start download: {}", e))?;
        
        if !response.status().is_success() && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            return Err(format!("HTTP error: {}", response.status()));
        }
        
        let start_time = std::time::Instant::now();
        let mut last_report_time = start_time;
        let mut last_report_downloaded = downloaded;
        
        let mut stream = response.bytes_stream();
        
        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result.map_err(|e| format!("Download error: {}", e))?;
            
            file.write_all(&chunk)
                .map_err(|e| format!("Failed to write chunk: {}", e))?;
            
            downloaded += chunk.len() as u64;
            
            let now = std::time::Instant::now();
            if now.duration_since(last_report_time).as_millis() > 500 {
                let elapsed = now.duration_since(last_report_time).as_secs_f64();
                let bytes_diff = downloaded - last_report_downloaded;
                let speed = bytes_diff as f64 / elapsed;
                
                let remaining = total_size.saturating_sub(downloaded);
                let eta = if speed > 0.0 {
                    (remaining as f64 / speed) as u64
                } else {
                    0
                };
                
                progress_callback(DownloadProgress {
                    downloaded,
                    total: total_size,
                    speed,
                    eta_seconds: eta,
                });
                
                last_report_time = now;
                last_report_downloaded = downloaded;
            }
        }
        
        progress_callback(DownloadProgress {
            downloaded: total_size,
            total: total_size,
            speed: 0.0,
            eta_seconds: 0,
        });
        
        drop(file);
        fs::rename(&temp_path, save_path)
            .map_err(|e| format!("Failed to rename file: {}", e))?;
        
        Ok(())
    }
    
    pub async fn download_with_retry<F>(
        &self,
        url: &str,
        save_path: &str,
        progress_callback: F,
    ) -> Result<(), String>
    where
        F: FnMut(DownloadProgress) + Send + Clone + 'static,
    {
        let mut last_error = String::new();
        
        for attempt in 1..=self.max_retries {
            let callback = progress_callback.clone();
            match self.download_with_resume(url, save_path, callback).await {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last_error = e;
                    eprintln!("Download attempt {} failed: {}", attempt, last_error);
                    
                    if attempt < self.max_retries {
                        let delay = Duration::from_secs(2_u64.pow(attempt - 1));
                        eprintln!("Retrying in {} seconds...", delay.as_secs());
                        sleep(delay).await;
                    }
                }
            }
        }
        
        Err(format!("Download failed after {} attempts: {}", self.max_retries, last_error))
    }
}

pub struct ModelDownloader {
    downloader: Downloader,
    models_dir: String,
}

impl ModelDownloader {
    pub fn new(proxy_config: Option<ProxyConfig>, models_dir: &str) -> Result<Self, String> {
        let downloader = Downloader::new(proxy_config)
            .map_err(|e| e.to_string())?;
        
        fs::create_dir_all(models_dir)
            .map_err(|e| format!("Failed to create models dir: {}", e))?;
        
        Ok(Self {
            downloader,
            models_dir: models_dir.to_string(),
        })
    }
    
    pub fn get_model_path(&self, model_name: &str) -> String {
        format!("{}/{}", self.models_dir, model_name)
    }
    
    pub fn is_model_downloaded(&self, model_name: &str) -> bool {
        let path = self.get_model_path(model_name);
        Path::new(&path).exists()
    }
    
    fn get_model_url(model_name: &str) -> Option<&'static str> {
        match model_name {
            "sam_vit_h_4b8939.pth" => Some("https://dl.fbaipublicfiles.com/segment_anything/sam_vit_h_4b8939.pth"),
            "sam_vit_l_0b3195.pth" => Some("https://dl.fbaipublicfiles.com/segment_anything/sam_vit_l_0b3195.pth"),
            "sam_vit_b_01ec64.pth" => Some("https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth"),
            _ => None,
        }
    }
    
    pub fn get_model_size(model_name: &str) -> u64 {
        match model_name {
            "sam_vit_h_4b8939.pth" => 2_400_000_000,
            "sam_vit_l_0b3195.pth" => 1_200_000_000,
            "sam_vit_b_01ec64.pth" => 375_000_000,
            _ => 0,
        }
    }
    
    pub async fn download_model<F>(
        &self,
        model_name: &str,
        progress_callback: F,
    ) -> Result<String, String>
    where
        F: FnMut(DownloadProgress) + Send + Clone + 'static,
    {
        let url = Self::get_model_url(model_name)
            .ok_or_else(|| format!("Unknown model: {}", model_name))?;
        
        let save_path = self.get_model_path(model_name);
        
        if self.is_model_downloaded(model_name) {
            let metadata = fs::metadata(&save_path)
                .map_err(|e| format!("Failed to read model file: {}", e))?;
            
            let expected_size = Self::get_model_size(model_name);
            if metadata.len() >= expected_size * 95 / 100 {
                println!("Model already downloaded: {}", save_path);
                return Ok(save_path);
            }
            
            println!("Model file incomplete, re-downloading...");
        }
        
        println!("Downloading model from: {}", url);
        
        self.downloader
            .download_with_retry(url, &save_path, progress_callback)
            .await?;
        
        println!("Model downloaded successfully: {}", save_path);
        
        Ok(save_path)
    }
    
    pub fn remove_model(&self, model_name: &str) -> Result<(), String> {
        let path = self.get_model_path(model_name);
        if Path::new(&path).exists() {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed to remove model: {}", e))?;
        }
        Ok(())
    }
}
