#![allow(dead_code)]
//! Secure P2P Mod Sharing Module
//!
//! Provides secure peer-to-peer mod pack sharing functionality with:
//! - AES-256-GCM encryption for all transfers
//! - SHA256 integrity verification
//! - Random share code generation for peer discovery
//! - TCP-based file transfer with progress tracking

// use crate::ip_obfuscation; // Disabled - P2P stub mode
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use bincode;
use log::{error, info, warn};
use rand::{rngs::OsRng as RandOsRng, Rng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

// ============================================================================
// CONSTANTS
// ============================================================================

/// Default port range for P2P sharing
const P2P_PORT_START: u16 = 47820;
const P2P_PORT_END: u16 = 47830;

/// Maximum file size for single transfer (2GB)
const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024 * 1024;

/// Chunk size for file transfer (1MB)
const CHUNK_SIZE: usize = 1024 * 1024;

/// Protocol version for compatibility checking
const PROTOCOL_VERSION: u32 = 1;

/// Magic bytes to identify our protocol
const MAGIC_BYTES: &[u8; 4] = b"RPMK";

// ============================================================================
// DATA STRUCTURES
// ============================================================================

/// Represents a mod pack that can be shared
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareableModPack {
    /// Display name for the mod pack
    pub name: String,
    /// Description of the mod pack
    pub description: String,
    /// List of mod files to share
    pub mods: Vec<ShareableMod>,
    /// Timestamp when created
    pub created_at: u64,
    /// Creator identifier (optional)
    pub creator: Option<String>,
}

/// Represents a single mod file in a pack
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareableMod {
    /// Original filename
    pub filename: String,
    /// File size in bytes
    pub size: u64,
    /// SHA256 hash of the file
    pub hash: String,
    /// Associated IoStore files (if any)
    pub iostore_files: Vec<IoStoreFile>,
}

/// IoStore companion file info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IoStoreFile {
    pub extension: String, // "ucas" or "utoc"
    pub size: u64,
    pub hash: String,
}

/// Share session info (returned when hosting)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareSession {
    /// Unique share code (user-friendly format)
    pub share_code: String,
    /// The encryption key (base64 encoded, part of full code)
    pub encryption_key: String,
    /// Local IP address (internal use only - not serialized to frontend)
    #[serde(skip_serializing)]
    pub local_ip: String,
    /// Obfuscated IP for display purposes
    pub obfuscated_ip: String,
    /// Port listening on
    pub port: u16,
    /// Full connection string for sharing
    pub connection_string: String,
    /// Obfuscated connection string for display purposes
    pub obfuscated_connection_string: String,
    /// Is the session active
    pub active: bool,
}

/// Message types for P2P protocol
#[derive(Debug, Clone, Serialize, Deserialize)]
enum P2PMessage {
    /// Initial handshake
    Hello {
        protocol_version: u32,
        client_name: Option<String>,
    },
    /// Handshake response
    Welcome {
        protocol_version: u32,
        pack_info: ShareableModPack,
    },
    /// Request to download a file
    RequestFile { filename: String },
    /// File data chunk
    FileChunk {
        filename: String,
        offset: u64,
        data: Vec<u8>,
        is_last: bool,
    },
    /// Transfer complete
    TransferComplete { filename: String, hash: String },
    /// Error message
    Error { message: String },
    /// Acknowledge receipt
    Ack,
    /// Session ended
    Goodbye,
}

/// Progress info for transfers
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferProgress {
    pub current_file: String,
    pub files_completed: usize,
    pub total_files: usize,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub status: TransferStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TransferStatus {
    Connecting,
    Handshaking,
    Transferring,
    Verifying,
    Completed,
    Failed(String),
    Cancelled,
}

/// Result type for P2P operations
pub type P2PResult<T> = Result<T, P2PError>;

/// P2P error types
#[derive(Debug, Clone)]
pub enum P2PError {
    NetworkError(String),
    EncryptionError(String),
    ProtocolError(String),
    FileError(String),
    ValidationError(String),
    ConnectionError(String),
    Cancelled,
}

impl std::fmt::Display for P2PError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            P2PError::NetworkError(msg) => write!(f, "Network error: {}", msg),
            P2PError::EncryptionError(msg) => write!(f, "Encryption error: {}", msg),
            P2PError::ProtocolError(msg) => write!(f, "Protocol error: {}", msg),
            P2PError::FileError(msg) => write!(f, "File error: {}", msg),
            P2PError::ValidationError(msg) => write!(f, "Validation error: {}", msg),
            P2PError::ConnectionError(msg) => write!(f, "Connection error: {}", msg),
            P2PError::Cancelled => write!(f, "Operation cancelled"),
        }
    }
}

impl std::error::Error for P2PError {}

// ============================================================================
// ENCRYPTION UTILITIES
// ============================================================================

/// Generates a new random 256-bit encryption key
pub fn generate_encryption_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    RandOsRng.fill_bytes(&mut key);
    key
}

/// Encrypts data using AES-256-GCM
pub fn encrypt_data(key: &[u8; 32], plaintext: &[u8]) -> P2PResult<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| P2PError::EncryptionError(format!("Failed to create cipher: {}", e)))?;

    // Generate random nonce
    let mut nonce_bytes = [0u8; 12];
    RandOsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| P2PError::EncryptionError(format!("Encryption failed: {}", e)))?;

    // Prepend nonce to ciphertext
    let mut result = nonce_bytes.to_vec();
    result.extend(ciphertext);
    Ok(result)
}

/// Decrypts data using AES-256-GCM
pub fn decrypt_data(key: &[u8; 32], ciphertext: &[u8]) -> P2PResult<Vec<u8>> {
    if ciphertext.len() < 12 {
        return Err(P2PError::EncryptionError(
            "Ciphertext too short".to_string(),
        ));
    }

    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| P2PError::EncryptionError(format!("Failed to create cipher: {}", e)))?;

    let nonce = Nonce::from_slice(&ciphertext[..12]);
    let plaintext = cipher
        .decrypt(nonce, &ciphertext[12..])
        .map_err(|e| P2PError::EncryptionError(format!("Decryption failed: {}", e)))?;

    Ok(plaintext)
}

// ============================================================================
// SHARE CODE UTILITIES
// ============================================================================

/// Generates a user-friendly share code
/// Format: XXXX-XXXX-XXXX where X is alphanumeric (no ambiguous chars)
pub fn generate_share_code() -> String {
    const CHARSET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // No 0,1,I,O
    let mut rng = RandOsRng;
    let mut code = String::with_capacity(14);

    for i in 0..12 {
        if i > 0 && i % 4 == 0 {
            code.push('-');
        }
        let idx = rng.gen_range(0..CHARSET.len());
        code.push(CHARSET[idx] as char);
    }

    code
}

/// Creates a full connection string from components
/// Format: share_code:key_base64:ip:port
pub fn create_connection_string(share_code: &str, key: &[u8; 32], ip: &str, port: u16) -> String {
    let key_b64 = URL_SAFE_NO_PAD.encode(key);
    format!("{}:{}:{}:{}", share_code, key_b64, ip, port)
}

/// Creates an obfuscated connection string for display
/// Format: share_code:key_base64:obfuscated_ip:port
pub fn create_obfuscated_connection_string(
    share_code: &str,
    key: &[u8; 32],
    ip: &str,
    port: u16,
) -> String {
    let key_b64 = URL_SAFE_NO_PAD.encode(key);
    let obfuscated_ip = format!("[{}]", &ip[..ip.len().min(4)]); // Simple obfuscation
    format!("{}:{}:{}:{}", share_code, key_b64, obfuscated_ip, port)
}

/// Parses a connection string into components
pub fn parse_connection_string(conn_str: &str) -> P2PResult<(String, [u8; 32], String, u16)> {
    let parts: Vec<&str> = conn_str.split(':').collect();
    if parts.len() != 4 {
        return Err(P2PError::ValidationError(
            "Invalid connection string format".to_string(),
        ));
    }

    let share_code = parts[0].to_string();

    let key_bytes = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|e| P2PError::ValidationError(format!("Invalid key encoding: {}", e)))?;

    if key_bytes.len() != 32 {
        return Err(P2PError::ValidationError("Invalid key length".to_string()));
    }

    let mut key = [0u8; 32];
    key.copy_from_slice(&key_bytes);

    let ip = parts[2].to_string();
    let port: u16 = parts[3]
        .parse()
        .map_err(|e| P2PError::ValidationError(format!("Invalid port: {}", e)))?;

    Ok((share_code, key, ip, port))
}

// ============================================================================
// FILE UTILITIES
// ============================================================================

/// Calculate SHA256 hash of a file
pub fn hash_file(path: &Path) -> P2PResult<String> {
    let file =
        File::open(path).map_err(|e| P2PError::FileError(format!("Failed to open file: {}", e)))?;

    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; CHUNK_SIZE];

    loop {
        let bytes_read = reader
            .read(&mut buffer)
            .map_err(|e| P2PError::FileError(format!("Failed to read file: {}", e)))?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    Ok(hex::encode(hasher.finalize()))
}

/// Creates a ShareableModPack from a list of mod paths
pub fn create_mod_pack(
    name: String,
    description: String,
    mod_paths: &[PathBuf],
    creator: Option<String>,
) -> P2PResult<ShareableModPack> {
    let mut mods = Vec::new();

    for path in mod_paths {
        if !path.exists() {
            return Err(P2PError::FileError(format!(
                "File not found: {}",
                path.display()
            )));
        }

        let metadata = fs::metadata(path)
            .map_err(|e| P2PError::FileError(format!("Failed to get metadata: {}", e)))?;

        if metadata.len() > MAX_FILE_SIZE {
            return Err(P2PError::FileError(format!(
                "File too large: {} ({} bytes)",
                path.display(),
                metadata.len()
            )));
        }

        let hash = hash_file(path)?;
        let raw_filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| P2PError::FileError("Invalid filename".to_string()))?
            .to_string();
        // Normalize disabled mod extensions so receiver always gets .pak
        let filename = if raw_filename.ends_with(".bak_repak") {
            format!("{}.pak", raw_filename.trim_end_matches(".bak_repak"))
        } else {
            raw_filename
        };

        // Check for IoStore companion files
        let mut iostore_files = Vec::new();
        for ext in &["ucas", "utoc"] {
            let companion = crate::xtra_bundle::companion(path, ext); // repakxtra: keeps dots in the name
            if companion.exists() {
                let comp_meta = fs::metadata(&companion).map_err(|e| {
                    P2PError::FileError(format!("Failed to get companion metadata: {}", e))
                })?;
                let comp_hash = hash_file(&companion)?;
                iostore_files.push(IoStoreFile {
                    extension: ext.to_string(),
                    size: comp_meta.len(),
                    hash: comp_hash,
                });
            }
        }

        mods.push(ShareableMod {
            filename,
            size: metadata.len(),
            hash,
            iostore_files,
        });
    }

    Ok(ShareableModPack {
        name,
        description,
        mods,
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        creator,
    })
}

// ============================================================================
// P2P SERVER (HOST) IMPLEMENTATION
// ============================================================================

/// Pack preview for frontend display
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackPreview {
    pub total_size: u64,
    pub file_count: usize,
}

/// Creates a lightweight preview of a mod pack (total size and file count). repakxtra: sizes come from file metadata
/// only, so changing the selection never reads the files (create_mod_pack hashes them once, when sharing starts).
pub fn create_mod_pack_preview(
    _name: String,
    _description: String,
    mod_paths: &[PathBuf],
    _creator: Option<String>,
) -> P2PResult<PackPreview> {
    let mut total_size = 0u64;
    let mut file_count = 0usize;
    for path in mod_paths {
        let meta = fs::metadata(path)
            .map_err(|e| P2PError::FileError(format!("File not found: {} ({})", path.display(), e)))?;
        if meta.len() > MAX_FILE_SIZE {
            return Err(P2PError::FileError(format!("File too large: {} ({} bytes)", path.display(), meta.len())));
        }
        total_size += meta.len();
        file_count += 1;
        for ext in ["ucas", "utoc"] {
            if let Ok(m) = fs::metadata(crate::xtra_bundle::companion(path, ext)) {
                total_size += m.len();
                file_count += 1;
            }
        }
    }
    Ok(PackPreview {
        total_size,
        file_count,
    })
}

/// Active share session manager
pub struct P2PServer {
    listener: Option<TcpListener>,
    session: ShareSession,
    mod_pack: ShareableModPack,
    mod_paths: HashMap<String, PathBuf>,
    encryption_key: [u8; 32],
    stop_flag: Arc<AtomicBool>,
    active_connections: Arc<Mutex<usize>>,
}

impl P2PServer {
    /// Create a new P2P server for sharing mods
    pub fn new(mod_pack: ShareableModPack, mod_paths: Vec<PathBuf>) -> P2PResult<Self> {
        // Generate encryption key
        let encryption_key = generate_encryption_key();

        // Find an available port
        let mut listener = None;
        let mut port = 0;

        for p in P2P_PORT_START..=P2P_PORT_END {
            match TcpListener::bind(("0.0.0.0", p)) {
                Ok(l) => {
                    listener = Some(l);
                    port = p;
                    break;
                }
                Err(_) => continue,
            }
        }

        let listener = listener
            .ok_or_else(|| P2PError::NetworkError("No available ports in range".to_string()))?;

        // Get local IP
        let local_ip = local_ip_address::local_ip()
            .map(|ip| ip.to_string())
            .unwrap_or_else(|_| "127.0.0.1".to_string());

        // Generate share code
        let share_code = generate_share_code();
        let key_b64 = URL_SAFE_NO_PAD.encode(&encryption_key);
        let connection_string =
            create_connection_string(&share_code, &encryption_key, &local_ip, port);
        let obfuscated_connection_string =
            create_obfuscated_connection_string(&share_code, &encryption_key, &local_ip, port);

        // Build path map (keys are normalized .pak filenames to match share metadata)
        let mut path_map = HashMap::new();
        for path in mod_paths {
            if let Some(raw_name) = path.file_name().and_then(|n| n.to_str()) {
                // Normalize .bak_repak → .pak so requests from receiver match
                let key = if raw_name.ends_with(".bak_repak") {
                    format!("{}.pak", raw_name.trim_end_matches(".bak_repak"))
                } else {
                    raw_name.to_string()
                };
                path_map.insert(key, path.clone());

                // Also add IoStore files
                for ext in &["ucas", "utoc"] {
                    let companion = crate::xtra_bundle::companion(&path, ext); // repakxtra: keeps dots in the name
                    if companion.exists() {
                        if let Some(comp_name) = companion.file_name().and_then(|n| n.to_str()) {
                            path_map.insert(comp_name.to_string(), companion);
                        }
                    }
                }
            }
        }

        let session = ShareSession {
            share_code,
            encryption_key: key_b64,
            obfuscated_ip: format!("[{}...]", &local_ip[..local_ip.len().min(4)]),
            local_ip,
            port,
            connection_string,
            obfuscated_connection_string,
            active: true,
        };

        info!(
            "P2P Server created on port {} with code {}",
            port, session.share_code
        );

        Ok(Self {
            listener: Some(listener),
            session,
            mod_pack,
            mod_paths: path_map,
            encryption_key,
            stop_flag: Arc::new(AtomicBool::new(false)),
            active_connections: Arc::new(Mutex::new(0)),
        })
    }

    /// Get the current session info
    pub fn get_session(&self) -> ShareSession {
        self.session.clone()
    }

    /// Get the raw encryption key bytes
    pub fn encryption_key_bytes(&self) -> &[u8; 32] {
        &self.encryption_key
    }

    /// Get a clone of the stop flag for external signaling
    pub fn get_stop_flag(&self) -> Arc<AtomicBool> {
        self.stop_flag.clone()
    }

    /// Start accepting connections (blocking)
    pub fn run(&mut self) -> P2PResult<()> {
        let listener = self
            .listener
            .take()
            .ok_or_else(|| P2PError::NetworkError("Server already started".to_string()))?;

        listener
            .set_nonblocking(true)
            .map_err(|e| P2PError::NetworkError(format!("Failed to set non-blocking: {}", e)))?;

        info!("P2P Server listening for connections...");

        while !self.stop_flag.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, addr)) => {
                    info!("New connection from: {}", addr);
                    if let Err(e) = self.handle_connection(stream, addr) {
                        warn!("Connection handler error: {} — continuing to accept", e);
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
                Err(e) => {
                    error!("Accept error: {}", e);
                }
            }
        }

        Ok(())
    }

    /// Stop the server
    pub fn stop(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
    }

    /// Handle a single client connection
    fn handle_connection(&self, mut stream: TcpStream, addr: SocketAddr) -> P2PResult<()> {
        // The listener is non-blocking for the accept loop, but accepted
        // streams must be switched back to blocking for read/write to work.
        stream
            .set_nonblocking(false)
            .map_err(|e| P2PError::NetworkError(format!("Failed to set blocking: {}", e)))?;
        stream
            .set_nodelay(true)
            .map_err(|e| P2PError::NetworkError(format!("Failed to set nodelay: {}", e)))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(120)))
            .map_err(|e| P2PError::NetworkError(format!("Failed to set timeout: {}", e)))?;
        stream
            .set_write_timeout(Some(Duration::from_secs(120)))
            .map_err(|e| P2PError::NetworkError(format!("Failed to set timeout: {}", e)))?;

        // Increment active connections
        {
            let mut count = self.active_connections.lock().unwrap();
            *count += 1;
        }

        let result = self.handle_client_session(&mut stream);

        // Decrement active connections
        {
            let mut count = self.active_connections.lock().unwrap();
            *count = count.saturating_sub(1);
        }

        if let Err(ref e) = result {
            warn!("Connection from {} ended with error: {}", addr, e);
        } else {
            info!("Connection from {} completed successfully", addr);
        }

        result
    }

    /// Handle the client session protocol
    fn handle_client_session(&self, stream: &mut TcpStream) -> P2PResult<()> {
        // Read hello message
        let hello_data = read_encrypted_message(stream, &self.encryption_key)?;
        let hello: P2PMessage = bincode::deserialize(&hello_data)
            .map_err(|e| P2PError::ProtocolError(format!("Invalid hello message: {}", e)))?;

        match hello {
            P2PMessage::Hello {
                protocol_version,
                client_name,
            } => {
                if protocol_version != PROTOCOL_VERSION {
                    let error = P2PMessage::Error {
                        message: format!(
                            "Protocol version mismatch: expected {}, got {}",
                            PROTOCOL_VERSION, protocol_version
                        ),
                    };
                    send_encrypted_message(stream, &self.encryption_key, &error)?;
                    return Err(P2PError::ProtocolError("Version mismatch".to_string()));
                }

                info!("Client connected: {:?}", client_name);

                // Send welcome with pack info
                let welcome = P2PMessage::Welcome {
                    protocol_version: PROTOCOL_VERSION,
                    pack_info: self.mod_pack.clone(),
                };
                send_encrypted_message(stream, &self.encryption_key, &welcome)?;
                info!("[Server] Welcome sent, entering file-request loop");
            }
            _ => {
                return Err(P2PError::ProtocolError(
                    "Expected Hello message".to_string(),
                ));
            }
        }

        // Handle file requests
        loop {
            info!("[Server] Waiting for next message from client...");
            let msg_data = match read_encrypted_message(stream, &self.encryption_key) {
                Ok(data) => {
                    info!("[Server] Received message ({} bytes)", data.len());
                    data
                }
                Err(P2PError::NetworkError(ref msg)) => {
                    warn!("[Server] Connection lost while reading: {}", msg);
                    break;
                }
                Err(e) => return Err(e),
            };

            let msg: P2PMessage = bincode::deserialize(&msg_data)
                .map_err(|e| P2PError::ProtocolError(format!("Invalid message: {}", e)))?;

            match msg {
                P2PMessage::RequestFile { filename } => {
                    self.send_file(stream, &filename)?;
                }
                P2PMessage::Goodbye => {
                    info!("Client disconnected gracefully");
                    break;
                }
                _ => {
                    warn!("Unexpected message type");
                }
            }
        }

        Ok(())
    }

    /// Send a file to the client
    fn send_file(&self, stream: &mut TcpStream, filename: &str) -> P2PResult<()> {
        let path = self
            .mod_paths
            .get(filename)
            .ok_or_else(|| P2PError::FileError(format!("File not found: {}", filename)))?;

        let file = File::open(path)
            .map_err(|e| P2PError::FileError(format!("Failed to open file: {}", e)))?;
        let file_size = file
            .metadata()
            .map_err(|e| P2PError::FileError(format!("Failed to get file size: {}", e)))?
            .len();

        let mut reader = BufReader::new(file);
        let mut buffer = vec![0u8; CHUNK_SIZE];
        let mut offset = 0u64;
        let mut hasher = Sha256::new();

        info!("Sending file: {} ({} bytes)", filename, file_size);

        loop {
            let bytes_read = reader
                .read(&mut buffer)
                .map_err(|e| P2PError::FileError(format!("Failed to read file: {}", e)))?;

            if bytes_read == 0 {
                break;
            }

            hasher.update(&buffer[..bytes_read]);
            let is_last = offset + bytes_read as u64 >= file_size;

            let chunk = P2PMessage::FileChunk {
                filename: filename.to_string(),
                offset,
                data: buffer[..bytes_read].to_vec(),
                is_last,
            };

            send_encrypted_message(stream, &self.encryption_key, &chunk)?;

            // Wait for ACK
            let ack_data = read_encrypted_message(stream, &self.encryption_key)?;
            let _ack: P2PMessage = bincode::deserialize(&ack_data)
                .map_err(|e| P2PError::ProtocolError(format!("Invalid ACK: {}", e)))?;

            offset += bytes_read as u64;
        }

        // Send transfer complete with hash
        let hash = hex::encode(hasher.finalize());
        let complete = P2PMessage::TransferComplete {
            filename: filename.to_string(),
            hash,
        };
        send_encrypted_message(stream, &self.encryption_key, &complete)?;

        info!("File sent successfully: {}", filename);
        Ok(())
    }
}

// ============================================================================
// P2P CLIENT (RECEIVER) IMPLEMENTATION
// ============================================================================

/// P2P client for receiving mods
pub struct P2PClient {
    encryption_key: [u8; 32],
    server_addr: String,
    stop_flag: Arc<AtomicBool>,
    progress: Arc<Mutex<TransferProgress>>,
}

impl P2PClient {
    /// Create a new P2P client from raw components
    pub fn new(encryption_key: [u8; 32], server_addr: String) -> Self {
        Self {
            encryption_key,
            server_addr,
            stop_flag: Arc::new(AtomicBool::new(false)),
            progress: Arc::new(Mutex::new(TransferProgress {
                current_file: String::new(),
                files_completed: 0,
                total_files: 0,
                bytes_transferred: 0,
                total_bytes: 0,
                status: TransferStatus::Connecting,
            })),
        }
    }

    /// Get a shared handle to the progress tracker
    pub fn progress_handle(&self) -> Arc<Mutex<TransferProgress>> {
        self.progress.clone()
    }

    /// Get a clone of the stop flag for external signaling
    pub fn get_stop_flag(&self) -> Arc<AtomicBool> {
        self.stop_flag.clone()
    }

    /// Create a new P2P client from a connection string
    pub fn from_connection_string(conn_str: &str) -> P2PResult<Self> {
        let (_, key, ip, port) = parse_connection_string(conn_str)?;
        let server_addr = format!("{}:{}", ip, port);

        Ok(Self {
            encryption_key: key,
            server_addr,
            stop_flag: Arc::new(AtomicBool::new(false)),
            progress: Arc::new(Mutex::new(TransferProgress {
                current_file: String::new(),
                files_completed: 0,
                total_files: 0,
                bytes_transferred: 0,
                total_bytes: 0,
                status: TransferStatus::Connecting,
            })),
        })
    }

    /// Get current transfer progress
    pub fn get_progress(&self) -> TransferProgress {
        self.progress.lock().unwrap().clone()
    }

    /// Stop the transfer
    pub fn stop(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
    }

    /// Connect and download all mods to the specified directory. repakxtra: every exit leaves a final status in the
    /// progress handle (Completed, Failed or Cancelled), so a poller never shows a stale "Connecting".
    pub fn download_pack(
        &self,
        output_dir: &Path,
        client_name: Option<String>,
    ) -> P2PResult<ShareableModPack> {
        let result = self.download_pack_inner(output_dir, client_name);
        let mut progress = self.progress.lock().unwrap();
        progress.status = match &result {
            Ok(_) => TransferStatus::Completed,
            Err(P2PError::Cancelled) => TransferStatus::Cancelled,
            Err(e) => TransferStatus::Failed(e.to_string()),
        };
        result
    }

    fn cancelled(&self) -> bool {
        self.stop_flag.load(Ordering::SeqCst)
    }

    /// A read error after Cancel was pressed is the cancel, not a network failure.
    fn or_cancelled(&self, e: P2PError) -> P2PError {
        if self.cancelled() { P2PError::Cancelled } else { e }
    }

    fn download_pack_inner(
        &self,
        output_dir: &Path,
        client_name: Option<String>,
    ) -> P2PResult<ShareableModPack> {
        // Update progress
        {
            let mut progress = self.progress.lock().unwrap();
            progress.status = TransferStatus::Connecting;
        }

        // Connect to server
        info!("Connecting to {}", self.server_addr);
        let mut stream = TcpStream::connect(&self.server_addr)
            .map_err(|e| P2PError::NetworkError(format!("Failed to connect: {}", e)))?;

        stream
            .set_nodelay(true)
            .map_err(|e| P2PError::NetworkError(format!("Failed to set nodelay: {}", e)))?;
        // repakxtra: short read timeouts so a stalled read notices Cancel within a second (receive_full keeps the
        // overall 120 s idle limit)
        stream
            .set_read_timeout(Some(READ_POLL))
            .map_err(|e| P2PError::NetworkError(format!("Failed to set timeout: {}", e)))?;
        stream
            .set_write_timeout(Some(Duration::from_secs(120)))
            .map_err(|e| P2PError::NetworkError(format!("Failed to set timeout: {}", e)))?;

        // Update progress
        {
            let mut progress = self.progress.lock().unwrap();
            progress.status = TransferStatus::Handshaking;
        }

        // Send hello
        let hello = P2PMessage::Hello {
            protocol_version: PROTOCOL_VERSION,
            client_name,
        };
        send_encrypted_message(&mut stream, &self.encryption_key, &hello)?;

        // Receive welcome
        let welcome_data = self.read_message(&mut stream)?;
        let welcome: P2PMessage = bincode::deserialize(&welcome_data)
            .map_err(|e| P2PError::ProtocolError(format!("Invalid welcome: {}", e)))?;

        let pack_info = match welcome {
            P2PMessage::Welcome {
                protocol_version,
                pack_info,
            } => {
                if protocol_version != PROTOCOL_VERSION {
                    return Err(P2PError::ProtocolError(
                        "Protocol version mismatch".to_string(),
                    ));
                }
                pack_info
            }
            P2PMessage::Error { message } => {
                return Err(P2PError::ProtocolError(message));
            }
            _ => {
                return Err(P2PError::ProtocolError(
                    "Expected Welcome message".to_string(),
                ));
            }
        };

        info!("Connected to share: {}", pack_info.name);

        // repakxtra: the sender chooses every name and size, so the whole pack is checked before anything is written
        let files = plan_receive(&pack_info)?;
        let total_bytes: u64 = files.iter().map(|f| f.size).sum();

        // Brief pause to let relay tunnel stabilize before file requests
        std::thread::sleep(Duration::from_millis(500));

        // Update progress
        {
            let mut progress = self.progress.lock().unwrap();
            progress.total_files = files.len();
            progress.total_bytes = total_bytes;
            progress.status = TransferStatus::Transferring;
        }

        // Create output directory if needed
        fs::create_dir_all(output_dir).map_err(|e| {
            P2PError::FileError(format!("Failed to create output directory: {}", e))
        })?;

        // repakxtra: files arrive in a private folder as .part (the game only loads .pak/.utoc/.ucas) and replace the
        // installed mod only after every file arrived and matched its size and hash
        let staging = crate::xtra_bundle::staging_dir(output_dir, "incoming").map_err(P2PError::FileError)?;
        let result = self.receive_into(&mut stream, &files, &staging, output_dir);
        let _ = fs::remove_dir_all(&staging);
        result?;

        info!("Download completed: {} files", pack_info.mods.len());
        Ok(pack_info)
    }

    fn receive_into(
        &self,
        stream: &mut TcpStream,
        files: &[IncomingFile],
        staging: &Path,
        output_dir: &Path,
    ) -> P2PResult<()> {
        let mut bytes_transferred = 0u64;
        for (i, file) in files.iter().enumerate() {
            if self.cancelled() {
                return Err(P2PError::Cancelled);
            }
            let staged = staging.join(format!("{}.part", file.name));
            bytes_transferred += self.download_file(stream, file, &staged, bytes_transferred)?;
            let mut progress = self.progress.lock().unwrap();
            progress.files_completed = i + 1;
            progress.bytes_transferred = bytes_transferred;
        }

        // Send goodbye
        let goodbye = P2PMessage::Goodbye;
        send_encrypted_message(stream, &self.encryption_key, &goodbye)?;

        // Past this point the move into the mods folder finishes or undoes itself; Cancel no longer applies
        if self.cancelled() {
            return Err(P2PError::Cancelled);
        }
        {
            let mut progress = self.progress.lock().unwrap();
            progress.status = TransferStatus::Verifying;
        }
        let moves: Vec<(PathBuf, PathBuf)> = files
            .iter()
            .map(|f| (staging.join(format!("{}.part", f.name)), output_dir.join(&f.name)))
            .collect();
        match crate::xtra_bundle::replace_all(&moves) {
            Ok(Some(trash_id)) => info!("Replaced files are in Recently deleted ({})", trash_id),
            Ok(None) => {}
            Err(e) => return Err(P2PError::FileError(e)),
        }
        Ok(())
    }

    fn read_message(&self, stream: &mut TcpStream) -> P2PResult<Vec<u8>> {
        read_encrypted_message_with(stream, &self.encryption_key, Some(&*self.stop_flag), CLIENT_MAX_MESSAGE)
            .map_err(|e| self.or_cancelled(e))
    }

    /// Downloads one file to `staged` (a new file), checking each chunk's name, offset and the declared size.
    fn download_file(
        &self,
        stream: &mut TcpStream,
        file: &IncomingFile,
        staged: &Path,
        bytes_before: u64,
    ) -> P2PResult<u64> {
        let filename = file.name.as_str();
        // Update progress
        {
            let mut progress = self.progress.lock().unwrap();
            progress.current_file = filename.to_string();
        }

        // Request file
        let request = P2PMessage::RequestFile {
            filename: filename.to_string(),
        };
        send_encrypted_message(stream, &self.encryption_key, &request)?;

        let out = File::options()
            .write(true)
            .create_new(true)
            .open(staged)
            .map_err(|e| P2PError::FileError(format!("Failed to create file: {}", e)))?;
        let mut writer = BufWriter::new(out);
        let mut hasher = Sha256::new();
        let mut total_received = 0u64;

        // Chunks until TransferComplete (a zero-byte file has no chunk at all)
        loop {
            if self.cancelled() {
                return Err(P2PError::Cancelled);
            }
            let data = self.read_message(stream)?;
            let msg: P2PMessage = bincode::deserialize(&data)
                .map_err(|e| P2PError::ProtocolError(format!("Invalid chunk: {}", e)))?;

            match msg {
                P2PMessage::FileChunk {
                    filename: chunk_name,
                    offset,
                    data,
                    is_last: _,
                } => {
                    if chunk_name != filename || offset != total_received {
                        return Err(P2PError::ProtocolError(format!(
                            "Unexpected chunk for {} at {} while receiving {} at {}",
                            chunk_name, offset, filename, total_received
                        )));
                    }
                    let after = total_received
                        .checked_add(data.len() as u64)
                        .filter(|n| *n <= file.size)
                        .ok_or_else(|| {
                            P2PError::ValidationError(format!("{} is larger than the {} bytes it announced", filename, file.size))
                        })?;
                    hasher.update(&data);
                    writer
                        .write_all(&data)
                        .map_err(|e| P2PError::FileError(format!("Failed to write: {}", e)))?;
                    total_received = after;
                    {
                        let mut progress = self.progress.lock().unwrap();
                        progress.bytes_transferred = bytes_before + total_received;
                    }

                    // Send ACK
                    let ack = P2PMessage::Ack;
                    send_encrypted_message(stream, &self.encryption_key, &ack)?;
                }
                P2PMessage::TransferComplete { filename: done_name, hash } => {
                    writer
                        .flush()
                        .map_err(|e| P2PError::FileError(format!("Failed to flush: {}", e)))?;
                    let computed_hash = hex::encode(hasher.finalize());
                    if done_name != filename || total_received != file.size {
                        return Err(P2PError::ValidationError(format!(
                            "{} ended at {} of {} bytes",
                            filename, total_received, file.size
                        )));
                    }
                    if computed_hash != hash || computed_hash != file.hash {
                        return Err(P2PError::ValidationError(format!(
                            "Hash mismatch for {}: expected {}, got {}",
                            filename, file.hash, computed_hash
                        )));
                    }
                    break;
                }
                P2PMessage::Error { message } => {
                    return Err(P2PError::ProtocolError(message));
                }
                _ => {
                    return Err(P2PError::ProtocolError("Unexpected message".to_string()));
                }
            }
        }

        info!(
            "Downloaded and verified: {} ({} bytes)",
            filename, total_received
        );
        Ok(total_received)
    }
}

/// repakxtra: one file of an incoming pack, after its name and size were checked.
#[derive(Debug, Clone, PartialEq)]
pub struct IncomingFile {
    pub name: String,
    pub size: u64,
    pub hash: String,
}

/// Most files one pack may hold, and most bytes in total (MAX_FILE_SIZE still caps each file).
const MAX_PACK_FILES: usize = 3000;
const MAX_PACK_BYTES: u64 = 64 * 1024 * 1024 * 1024;
/// Largest message a receiver reads: a 1 MB chunk plus framing, or a pack description.
const CLIENT_MAX_MESSAGE: usize = 16 * 1024 * 1024;
const READ_POLL: Duration = Duration::from_secs(1);
const READ_IDLE_LIMIT: Duration = Duration::from_secs(120);

/// A file name a sender may use: one plain name Windows accepts (no folders, drive, stream, device name or trailing
/// dot or space), so joining it to the mods folder can only name a file directly inside it.
pub fn safe_file_name(name: &str) -> bool {
    const RESERVED: [&str; 22] = [
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
        "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    !name.is_empty()
        && name.len() <= 200
        && name != "."
        && name != ".."
        && !name.ends_with('.')
        && !name.ends_with(' ')
        && !name.chars().any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
        && !RESERVED.contains(&stem.as_str())
}

/// Checks a whole pack before anything is written and lists its files in download order: each mod is one .pak with
/// at most one .utoc and one .ucas of the same name, sizes fit the limits, and no two names are the same file on
/// Windows (case-insensitive).
pub fn plan_receive(pack: &ShareableModPack) -> P2PResult<Vec<IncomingFile>> {
    let bad = |m: String| Err(P2PError::ValidationError(m));
    let mut files = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut total = 0u64;
    for m in &pack.mods {
        if !safe_file_name(&m.filename) || !m.filename.to_ascii_lowercase().ends_with(".pak") {
            return bad(format!("The share has a file name that is not allowed: {:?}", m.filename));
        }
        let mut exts = Vec::new();
        let mut list = vec![IncomingFile { name: m.filename.clone(), size: m.size, hash: m.hash.clone() }];
        for io in &m.iostore_files {
            let ext = io.extension.to_ascii_lowercase();
            if !(ext == "utoc" || ext == "ucas") || exts.contains(&ext) {
                return bad(format!("{} has an unexpected companion file: {:?}", m.filename, io.extension));
            }
            exts.push(ext.clone());
            let name = crate::xtra_bundle::companion(Path::new(&m.filename), &ext)
                .to_string_lossy()
                .to_string();
            list.push(IncomingFile { name, size: io.size, hash: io.hash.clone() });
        }
        for f in list {
            if f.size > MAX_FILE_SIZE {
                return bad(format!("{} is too large ({} bytes)", f.name, f.size));
            }
            if !seen.insert(f.name.to_lowercase()) {
                return bad(format!("The share lists {} twice", f.name));
            }
            total = match total.checked_add(f.size) {
                Some(t) if t <= MAX_PACK_BYTES => t,
                _ => return bad("The share is larger than a receive allows".to_string()),
            };
            files.push(f);
        }
    }
    if files.len() > MAX_PACK_FILES {
        return bad(format!("The share has {} files, more than {}", files.len(), MAX_PACK_FILES));
    }
    Ok(files)
}

// ============================================================================
// PROTOCOL HELPERS
// ============================================================================

/// Send an encrypted message over the stream
fn send_encrypted_message<T: Serialize>(
    stream: &mut TcpStream,
    key: &[u8; 32],
    message: &T,
) -> P2PResult<()> {
    let serialized = bincode::serialize(message)
        .map_err(|e| P2PError::ProtocolError(format!("Serialization failed: {}", e)))?;

    let encrypted = encrypt_data(key, &serialized)?;

    // Write magic bytes
    stream
        .write_all(MAGIC_BYTES)
        .map_err(|e| P2PError::NetworkError(format!("Failed to write magic: {}", e)))?;

    // Write length (4 bytes, big-endian)
    let len = encrypted.len() as u32;
    stream
        .write_all(&len.to_be_bytes())
        .map_err(|e| P2PError::NetworkError(format!("Failed to write length: {}", e)))?;

    // Write encrypted data
    stream
        .write_all(&encrypted)
        .map_err(|e| P2PError::NetworkError(format!("Failed to write data: {}", e)))?;

    stream
        .flush()
        .map_err(|e| P2PError::NetworkError(format!("Failed to flush: {}", e)))?;

    Ok(())
}

/// Read an encrypted message from the stream
fn read_encrypted_message(stream: &mut TcpStream, key: &[u8; 32]) -> P2PResult<Vec<u8>> {
    read_encrypted_message_with(stream, key, None, 100 * 1024 * 1024)
}

/// repakxtra: fills `buf`, treating read timeouts as polls: returns Cancelled once `stop` is set and gives up after
/// READ_IDLE_LIMIT without a byte. With no stop flag a timeout is an error, as before.
fn receive_full(stream: &mut TcpStream, buf: &mut [u8], stop: Option<&AtomicBool>, what: &str) -> P2PResult<()> {
    let mut filled = 0usize;
    let mut idle_since = std::time::Instant::now();
    while filled < buf.len() {
        if stop.is_some_and(|s| s.load(Ordering::SeqCst)) {
            return Err(P2PError::Cancelled);
        }
        match stream.read(&mut buf[filled..]) {
            Ok(0) => {
                return Err(P2PError::NetworkError(format!(
                    "Connection closed after reading {}/{} bytes of {}",
                    filled,
                    buf.len(),
                    what
                )))
            }
            Ok(n) => {
                filled += n;
                idle_since = std::time::Instant::now();
            }
            Err(e)
                if stop.is_some()
                    && matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)
                    && idle_since.elapsed() < READ_IDLE_LIMIT => {}
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(P2PError::NetworkError(format!("Failed to read {}: {}", what, e))),
        }
    }
    Ok(())
}

fn read_encrypted_message_with(
    stream: &mut TcpStream,
    key: &[u8; 32],
    stop: Option<&AtomicBool>,
    max_len: usize,
) -> P2PResult<Vec<u8>> {
    let mut magic = [0u8; 4];
    receive_full(stream, &mut magic, stop, "magic bytes")?;

    if &magic != MAGIC_BYTES {
        return Err(P2PError::ProtocolError(format!(
            "Invalid magic bytes: got {:?}, expected {:?}",
            magic, MAGIC_BYTES
        )));
    }

    // Read length
    let mut len_bytes = [0u8; 4];
    receive_full(stream, &mut len_bytes, stop, "length")?;
    let len = u32::from_be_bytes(len_bytes) as usize;

    if len > max_len {
        return Err(P2PError::ProtocolError("Message too large".to_string()));
    }

    // Read encrypted data
    let mut encrypted = vec![0u8; len];
    receive_full(stream, &mut encrypted, stop, "data")?;

    // Decrypt
    decrypt_data(key, &encrypted)
}

// ============================================================================
// STATE MANAGEMENT FOR ACTIVE SESSIONS
// ============================================================================

/// Global state for managing active P2P sessions
pub struct P2PManager {
    active_server: Option<Arc<Mutex<P2PServer>>>,
    server_thread: Option<thread::JoinHandle<()>>,
    active_client: Option<Arc<P2PClient>>,
    client_thread: Option<thread::JoinHandle<P2PResult<ShareableModPack>>>,
}

impl P2PManager {
    pub fn new() -> Self {
        Self {
            active_server: None,
            server_thread: None,
            active_client: None,
            client_thread: None,
        }
    }

    /// Start hosting a mod pack
    pub fn start_sharing(
        &mut self,
        name: String,
        description: String,
        mod_paths: Vec<PathBuf>,
        creator: Option<String>,
    ) -> P2PResult<ShareSession> {
        // Stop any existing session
        self.stop_sharing();

        // Create mod pack
        let pack = create_mod_pack(name, description, &mod_paths, creator)?;

        // Create server
        let server = P2PServer::new(pack, mod_paths)?;
        let session = server.get_session();

        let server = Arc::new(Mutex::new(server));
        let server_clone = server.clone();

        // Start server thread
        let handle = thread::spawn(move || {
            if let Ok(mut server) = server_clone.lock() {
                if let Err(e) = server.run() {
                    error!("P2P Server error: {}", e);
                }
            }
        });

        self.active_server = Some(server);
        self.server_thread = Some(handle);

        Ok(session)
    }

    /// Stop hosting
    pub fn stop_sharing(&mut self) {
        if let Some(server) = self.active_server.take() {
            if let Ok(s) = server.lock() {
                s.stop();
            }
        }

        if let Some(handle) = self.server_thread.take() {
            let _ = handle.join();
        }
    }

    /// Get current share session info
    pub fn get_share_session(&self) -> Option<ShareSession> {
        self.active_server
            .as_ref()
            .and_then(|s| s.lock().ok().map(|server| server.get_session()))
    }

    /// Check if currently sharing
    pub fn is_sharing(&self) -> bool {
        self.active_server.is_some()
    }

    /// Start receiving mods from a connection string
    pub fn start_receiving(
        &mut self,
        connection_string: &str,
        output_dir: PathBuf,
        client_name: Option<String>,
    ) -> P2PResult<()> {
        // Stop any existing receive
        self.stop_receiving();

        let client = Arc::new(P2PClient::from_connection_string(connection_string)?);
        let client_clone = client.clone();

        let handle = thread::spawn(move || client_clone.download_pack(&output_dir, client_name));

        self.active_client = Some(client);
        self.client_thread = Some(handle);

        Ok(())
    }

    /// Stop receiving
    pub fn stop_receiving(&mut self) {
        if let Some(client) = self.active_client.take() {
            client.stop();
        }

        if let Some(handle) = self.client_thread.take() {
            let _ = handle.join();
        }
    }

    /// Get current transfer progress
    pub fn get_receive_progress(&self) -> Option<TransferProgress> {
        self.active_client.as_ref().map(|c| c.get_progress())
    }

    /// Check if currently receiving
    pub fn is_receiving(&self) -> bool {
        self.active_client.is_some()
    }

    /// Check if receive completed and get result
    pub fn check_receive_result(&mut self) -> Option<P2PResult<ShareableModPack>> {
        if let Some(handle) = self.client_thread.take() {
            if handle.is_finished() {
                self.active_client = None;
                return Some(
                    handle
                        .join()
                        .unwrap_or(Err(P2PError::NetworkError("Thread panicked".to_string()))),
                );
            } else {
                self.client_thread = Some(handle);
            }
        }
        None
    }
}

impl Default for P2PManager {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_share_code_generation() {
        let code = generate_share_code();
        assert_eq!(code.len(), 14); // 12 chars + 2 dashes
        assert!(code.chars().filter(|c| *c == '-').count() == 2);
    }

    #[test]
    fn test_encryption_roundtrip() {
        let key = generate_encryption_key();
        let plaintext = b"Hello, World!";
        let encrypted = encrypt_data(&key, plaintext).unwrap();
        let decrypted = decrypt_data(&key, &encrypted).unwrap();
        assert_eq!(plaintext.to_vec(), decrypted);
    }

    #[test]
    fn test_connection_string_roundtrip() {
        let key = generate_encryption_key();
        let share_code = "TEST-CODE-1234";
        let ip = "192.168.1.100";
        let port = 47820u16;

        let conn_str = create_connection_string(share_code, &key, ip, port);
        let (parsed_code, parsed_key, parsed_ip, parsed_port) =
            parse_connection_string(&conn_str).unwrap();

        assert_eq!(share_code, parsed_code);
        assert_eq!(key, parsed_key);
        assert_eq!(ip, parsed_ip);
        assert_eq!(port, parsed_port);
    }

    // repakxtra: loopback receives through the real P2PClient. Every file lives in a fresh temp folder; servers listen
    // on 127.0.0.1 port 0 only.

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("repakxtra-p2p-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn sha(data: &[u8]) -> String {
        hex::encode(Sha256::digest(data))
    }

    fn one_mod(name: &str, data: &[u8]) -> ShareableModPack {
        ShareableModPack {
            name: "t".into(),
            description: String::new(),
            mods: vec![ShareableMod { filename: name.into(), size: data.len() as u64, hash: sha(data), iostore_files: vec![] }],
            created_at: 0,
            creator: None,
        }
    }

    /// A sender that follows `script` after the handshake: it gets the stream and the key.
    fn fake_sender<F>(pack: ShareableModPack, script: F) -> (String, [u8; 32])
    where
        F: FnOnce(&mut TcpStream, &[u8; 32]) + Send + 'static,
    {
        let key = generate_encryption_key();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let _hello = read_encrypted_message(&mut s, &key).unwrap();
            let welcome = P2PMessage::Welcome { protocol_version: PROTOCOL_VERSION, pack_info: pack };
            send_encrypted_message(&mut s, &key, &welcome).unwrap();
            script(&mut s, &key);
        });
        (addr, key)
    }

    fn send_chunk(s: &mut TcpStream, key: &[u8; 32], name: &str, offset: u64, data: &[u8]) {
        let chunk = P2PMessage::FileChunk { filename: name.into(), offset, data: data.to_vec(), is_last: true };
        send_encrypted_message(s, key, &chunk).unwrap();
        let _ = read_encrypted_message(s, key);
    }

    #[test]
    fn plan_receive_refuses_names_that_leave_the_folder() {
        for bad in ["../outside.pak", "..\\outside.pak", "C:\\x.pak", "a/b.pak", "x.pak:stream", "CON.pak", "x.pak.", "x.txt", ""] {
            assert!(plan_receive(&one_mod(bad, b"x")).is_err(), "accepted {:?}", bad);
        }
        let mut dup = one_mod("A.pak", b"x");
        dup.mods.push(dup.mods[0].clone());
        dup.mods[1].filename = "a.PAK".into();
        assert!(plan_receive(&dup).is_err(), "case-equivalent duplicate");
        let mut io = one_mod("Skin.v2_9999999_P.pak", b"x");
        io.mods[0].iostore_files = vec![
            IoStoreFile { extension: "utoc".into(), size: 1, hash: sha(b"t") },
            IoStoreFile { extension: "ucas".into(), size: 1, hash: sha(b"c") },
        ];
        let names: Vec<String> = plan_receive(&io).unwrap().into_iter().map(|f| f.name).collect();
        assert_eq!(names, ["Skin.v2_9999999_P.pak", "Skin.v2_9999999_P.utoc", "Skin.v2_9999999_P.ucas"]);
        io.mods[0].iostore_files[1].extension = "exe".into();
        assert!(plan_receive(&io).is_err(), "unknown companion extension");
    }

    #[test]
    fn a_traversal_name_writes_nothing() {
        let d = tmp("traversal");
        let mods = d.join("mods");
        fs::create_dir_all(&mods).unwrap();
        fs::write(d.join("outside.pak"), b"sentinel").unwrap();
        let (addr, key) = fake_sender(one_mod("../outside.pak", b"evil"), |s, k| {
            // a sender that answers anyway: the receiver must never ask
            if read_encrypted_message(s, k).is_ok() {
                send_chunk(s, k, "../outside.pak", 0, b"evil");
            }
        });
        let client = P2PClient::new(key, addr);
        assert!(matches!(client.download_pack(&mods, None), Err(P2PError::ValidationError(_))));
        assert_eq!(fs::read(d.join("outside.pak")).unwrap(), b"sentinel");
        assert!(matches!(client.get_progress().status, TransferStatus::Failed(_)));
        assert_eq!(fs::read_dir(&mods).unwrap().count(), 0, "no staging folder left behind");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn more_bytes_than_announced_are_refused_and_the_old_file_stays() {
        let d = tmp("oversize");
        fs::write(d.join("M.pak"), b"original").unwrap();
        let mut pack = one_mod("M.pak", b"x");
        pack.mods[0].size = 1;
        let (addr, key) = fake_sender(pack, |s, k| {
            let _ = read_encrypted_message(s, k);
            send_chunk(s, k, "M.pak", 0, b"thirteen bytes");
        });
        let client = P2PClient::new(key, addr);
        assert!(matches!(client.download_pack(&d, None), Err(P2PError::ValidationError(_))));
        assert_eq!(fs::read(d.join("M.pak")).unwrap(), b"original");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_disconnect_mid_file_leaves_the_installed_mod_untouched() {
        let d = tmp("disconnect");
        fs::write(d.join("M.pak"), b"original").unwrap();
        let data = vec![7u8; 64];
        let (addr, key) = fake_sender(one_mod("M.pak", &data), |s, k| {
            let _ = read_encrypted_message(s, k);
            let chunk = P2PMessage::FileChunk { filename: "M.pak".into(), offset: 0, data: vec![7u8; 32], is_last: false };
            send_encrypted_message(s, k, &chunk).unwrap();
            // drop the connection halfway
        });
        let client = P2PClient::new(key, addr);
        assert!(client.download_pack(&d, None).is_err());
        assert_eq!(fs::read(d.join("M.pak")).unwrap(), b"original");
        assert_eq!(fs::read_dir(&d).unwrap().count(), 1, "only the original file remains");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn cancel_ends_a_stalled_read_within_two_seconds() {
        let d = tmp("cancel");
        let (addr, key) = fake_sender(one_mod("M.pak", b"data"), |s, k| {
            let _ = read_encrypted_message(s, k);
            thread::sleep(Duration::from_secs(10)); // never answers
        });
        let client = P2PClient::new(key, addr);
        let stop = client.get_stop_flag();
        let started = std::time::Instant::now();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(800));
            stop.store(true, Ordering::SeqCst);
        });
        assert!(matches!(client.download_pack(&d, None), Err(P2PError::Cancelled)));
        assert!(started.elapsed() < Duration::from_millis(800) + Duration::from_secs(2), "took {:?}", started.elapsed());
        assert_eq!(client.get_progress().status, TransferStatus::Cancelled);
        assert!(!d.join("M.pak").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn preview_counts_companions_from_metadata() {
        let d = tmp("preview");
        fs::write(d.join("A.v2.pak"), vec![0u8; 10]).unwrap();
        fs::write(d.join("A.v2.utoc"), vec![0u8; 5]).unwrap();
        fs::write(d.join("A.ucas"), vec![0u8; 99]).unwrap(); // not A.v2's
        let p = create_mod_pack_preview(String::new(), String::new(), &[d.join("A.v2.pak")], None).unwrap();
        assert_eq!((p.file_count, p.total_size), (2, 15));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_refused_connection_ends_failed() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port(); // closed again at once
        let client = P2PClient::new(generate_encryption_key(), format!("127.0.0.1:{}", port));
        assert!(client.download_pack(&tmp("refused"), None).is_err());
        assert!(matches!(client.get_progress().status, TransferStatus::Failed(_)));
    }

    #[test]
    fn a_dotted_iostore_bundle_round_trips_through_the_real_sender() {
        let d = tmp("roundtrip");
        let (src, dst) = (d.join("src"), d.join("dst"));
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("Skin.v2_9999999_P.pak"), b"pak").unwrap();
        fs::write(src.join("Skin.v2_9999999_P.utoc"), b"utoc").unwrap();
        fs::write(src.join("Skin.v2_9999999_P.ucas"), vec![9u8; CHUNK_SIZE + 5]).unwrap(); // two chunks
        fs::write(src.join("Skin.ucas"), b"unrelated").unwrap();
        let paths = vec![src.join("Skin.v2_9999999_P.pak")];
        let pack = create_mod_pack("t".into(), String::new(), &paths, None).unwrap();
        assert_eq!(pack.mods[0].iostore_files.len(), 2);
        let mut path_map = HashMap::new();
        for n in ["Skin.v2_9999999_P.pak", "Skin.v2_9999999_P.utoc", "Skin.v2_9999999_P.ucas"] {
            path_map.insert(n.to_string(), src.join(n));
        }
        let key = generate_encryption_key();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = P2PServer {
            listener: None,
            session: ShareSession {
                share_code: String::new(), encryption_key: String::new(), local_ip: String::new(), obfuscated_ip: String::new(),
                port: 0, connection_string: String::new(), obfuscated_connection_string: String::new(), active: true,
            },
            mod_pack: pack,
            mod_paths: path_map,
            encryption_key: key,
            stop_flag: Arc::new(AtomicBool::new(false)),
            active_connections: Arc::new(Mutex::new(0)),
        };
        thread::spawn(move || {
            let (s, a) = listener.accept().unwrap();
            let _ = server.handle_connection(s, a);
        });
        let client = P2PClient::new(key, addr);
        let got = client.download_pack(&dst, None).unwrap();
        assert_eq!(got.mods.len(), 1);
        assert_eq!(fs::read(dst.join("Skin.v2_9999999_P.utoc")).unwrap(), b"utoc");
        assert_eq!(fs::read(dst.join("Skin.v2_9999999_P.ucas")).unwrap().len(), CHUNK_SIZE + 5);
        assert!(!dst.join("Skin.ucas").exists());
        assert_eq!(fs::read_dir(&dst).unwrap().count(), 3, "no staging folder left behind");
        assert_eq!(client.get_progress().status, TransferStatus::Completed);
        let _ = fs::remove_dir_all(&d);
    }
}
