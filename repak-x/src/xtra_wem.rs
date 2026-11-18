//! repakxtra: PCM in, Wwise .wem out, for the Sounds tab (xtra_sounds.rs). The game plays a Wwise PCM .wem dropped in
//! place of a sound in bnk_ui_battle: oZanderr/Rivals-Toolkit's sound mod builder ships exactly this (MIT or Apache-2.0,
//! src-tauri/src/audio/wem.rs), and its header below is theirs, taken from a PCM .wem the game itself ships: a
//! WAVE_FORMAT_EXTENSIBLE stereo 16-bit fmt chunk, the game's "hash" chunk, and two junk chunks. Mono is written to both
//! channels, as the header is stereo. Notice in xtra_wem.NOTICE.md beside this file.

/// The 96-byte header up to the data chunk. The RIFF size (4..8), sample rate (24..28), and bytes per second (28..32)
/// are filled in per sound.
const HEADER: [u8; 96] = [
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    0x66, 0x6D, 0x74, 0x20, 0x18, 0x00, 0x00, 0x00, 0xFE, 0xFF, 0x02, 0x00,
    0x80, 0xBB, 0x00, 0x00,
    0x00, 0x77, 0x01, 0x00,
    0x04, 0x00, 0x10, 0x00,
    0x06, 0x00, 0x00, 0x00, 0x02, 0x31, 0x00, 0x00,
    0x68, 0x61, 0x73, 0x68, 0x10, 0x00, 0x00, 0x00, 0x46, 0x26, 0xE0, 0xBF, 0x91, 0x29, 0x78, 0xDD,
    0x78, 0x67, 0x99, 0x9C, 0xA4, 0x66, 0xBA, 0x21,
    0x6A, 0x75, 0x6E, 0x6B, 0x0C, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x4A, 0x55, 0x4E, 0x4B, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

/// `pcm` interleaved 16-bit, mono or stereo. Returns the .wem bytes (always stereo).
pub fn encode(pcm: &[i16], rate: u32, channels: u16) -> Result<Vec<u8>, String> {
    if !(channels == 1 || channels == 2) { return Err("mono or stereo only".into()) }
    if pcm.len() < channels as usize { return Err("the sound is empty".into()) }
    let frames = pcm.len() / channels as usize;
    let data_len = (frames * 4) as u32;
    let mut out = Vec::with_capacity(104 + data_len as usize);
    out.extend_from_slice(&HEADER);
    out[4..8].copy_from_slice(&(80 + data_len).to_le_bytes()); // Rivals-Toolkit's value, kept as the game plays it
    out[24..28].copy_from_slice(&rate.to_le_bytes());
    out[28..32].copy_from_slice(&(rate * 4).to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for f in 0..frames {
        let (l, r) = if channels == 1 { (pcm[f], pcm[f]) } else { (pcm[2 * f], pcm[2 * f + 1]) };
        out.extend_from_slice(&l.to_le_bytes());
        out.extend_from_slice(&r.to_le_bytes());
    }
    Ok(out)
}

/// 10 ms of silence: what a layer that would stack a second copy of the slot's sound plays instead.
pub fn silence() -> Vec<u8> {
    encode(&[0; 480], 48000, 1).expect("480 mono frames")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_game_pcm_header_in_stereo() {
        let wem = encode(&[1, -2, 3], 44100, 1).unwrap();
        assert_eq!(&wem[0..4], b"RIFF");
        // the RIFF size Rivals-Toolkit writes (80 + the audio), 16 under the file's real size, as in the files it ships
        assert_eq!(u32::from_le_bytes(wem[4..8].try_into().unwrap()) as usize, 80 + 12, "RIFF size");
        assert_eq!(u16::from_le_bytes([wem[20], wem[21]]), 0xFFFE, "WAVE_FORMAT_EXTENSIBLE");
        assert_eq!(u16::from_le_bytes([wem[22], wem[23]]), 2, "stereo");
        assert_eq!(u32::from_le_bytes(wem[24..28].try_into().unwrap()), 44100);
        assert_eq!(&wem[96..100], b"data");
        assert_eq!(u32::from_le_bytes(wem[100..104].try_into().unwrap()), 12, "3 frames x 4 bytes");
        assert_eq!(&wem[104..], &[1, 0, 1, 0, 0xFE, 0xFF, 0xFE, 0xFF, 3, 0, 3, 0], "mono on both channels");
        let st = encode(&[5, 6], 48000, 2).unwrap();
        assert_eq!(&st[104..], &[5, 0, 6, 0]);
        assert_eq!(silence().len(), 104 + 480 * 4);
    }
}
