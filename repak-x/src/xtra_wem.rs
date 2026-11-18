//! repakxtra: PCM in, Wwise Vorbis .wem out, for the Sounds tab (xtra_sounds.rs). The game's banks declare Vorbis for
//! every sound, so a replacement has to be Wwise's stripped Vorbis. vorbis_rs (aoTuV 6.03) does the compression. This
//! file only rewraps it the way Wwise stores it. Ported from XzoundWave's XzoundCore (MIT, Copyright (c) 2026 Nikolas
//! Becic), whose output plays in game [modding-kb sound.md]: Ogg framing dropped, the setup packet rewritten with each
//! codebook as a 10-bit index into the aoTuV table the runtime carries (wem_codebooks.bin, aoTuV's data), audio packets
//! without their type bit and long-block window flags, and the fmt chunk's 48-byte extension (uMaxPacketSize is the
//! field the game needs: zero plays silent). Quality 0.5 is the value XzoundWave measured as decoding cleanly.
//! The MIT notice of XzoundWave and the Xiph.org BSD notice of the codebook table are in xtra_wem.NOTICE.md beside this file.

use std::num::{NonZeroU32, NonZeroU8};

const QUALITY: f32 = 0.5;
const SEEK_BLOCK: u32 = 16384;
static BOOKS: &[u8] = include_bytes!("wem_codebooks.bin");

struct Reader<'a> { d: &'a [u8], pos: usize }
impl Reader<'_> {
    fn read(&mut self, bits: u32) -> Result<u32, String> {
        let mut v = 0u32;
        for i in 0..bits {
            let b = *self.d.get(self.pos >> 3).ok_or("ran off the end of a Vorbis packet")?;
            v |= (((b >> (self.pos & 7)) & 1) as u32) << i;
            self.pos += 1;
        }
        Ok(v)
    }
    fn int(&mut self, bits: u32) -> Result<i64, String> { self.read(bits).map(i64::from) }
    fn flag(&mut self) -> Result<bool, String> { self.read(1).map(|b| b != 0) }
}

#[derive(Default)]
struct Writer { bytes: Vec<u8>, bit: u32 }
impl Writer {
    fn write(&mut self, v: i64, bits: u32) {
        for i in 0..bits {
            if self.bit == 0 { self.bytes.push(0) }
            if (v >> i) & 1 != 0 { *self.bytes.last_mut().unwrap() |= 1 << self.bit }
            self.bit = (self.bit + 1) & 7;
        }
    }
}

fn ilog(mut n: i64) -> u32 { let mut r = 0; while n > 0 { r += 1; n >>= 1 } r }

#[derive(PartialEq)]
struct Book { dims: i64, entries: i64, lengths: Vec<i64>, lookup: i64, min: u32, max: u32, value_bits: u32, seq: bool, mults: Vec<i64> }

fn quant_vals(entries: i64, dims: i64) -> i64 {
    let mut v = 1i64;
    while (v + 1).checked_pow(dims as u32).is_some_and(|p| p <= entries) { v += 1 }
    v
}

/// One codebook, from a standard setup packet (`packed` false) or the Wwise table (narrower fields, no sync word).
fn read_book(r: &mut Reader, packed: bool) -> Result<Book, String> {
    if !packed && r.read(24)? != 0x564342 { return Err("codebook sync missing".into()) }
    let (dims, entries) = if packed { (r.int(4)?, r.int(14)?) } else { (r.int(16)?, r.int(24)?) };
    let mut lengths = vec![0i64; entries as usize];
    if !r.flag()? {
        let bits = if packed { r.read(3)? } else { 5 };
        let sparse = r.flag()?;
        for l in lengths.iter_mut() { *l = if sparse && !r.flag()? { 0 } else { r.int(bits)? + 1 } }
    } else {
        let (mut cur, mut done) = (r.int(5)? + 1, 0i64);
        while done < entries {
            let n = r.int(ilog(entries - done))?;
            for i in 0..n { *lengths.get_mut((done + i) as usize).ok_or("bad ordered codebook")? = cur }
            done += n;
            cur += 1;
        }
    }
    let lookup = r.int(if packed { 1 } else { 4 })?;
    let mut b = Book { dims, entries, lengths, lookup, min: 0, max: 0, value_bits: 0, seq: false, mults: vec![] };
    if lookup == 1 || lookup == 2 {
        b.min = r.read(32)?;
        b.max = r.read(32)?;
        b.value_bits = r.read(4)? + 1;
        b.seq = r.flag()?;
        let n = if lookup == 1 { quant_vals(entries, dims) } else { entries * dims };
        for _ in 0..n { b.mults.push(r.int(b.value_bits)?) }
    }
    Ok(b)
}

fn library() -> &'static Vec<Option<Book>> {
    static LIB: std::sync::OnceLock<Vec<Option<Book>>> = std::sync::OnceLock::new();
    LIB.get_or_init(|| {
        let u32_at = |o: usize| u32::from_le_bytes(BOOKS[o..o + 4].try_into().unwrap()) as usize;
        let table = u32_at(BOOKS.len() - 4);
        let count = (BOOKS.len() - 4 - table) / 4;
        let offs: Vec<usize> = (0..count).map(|i| u32_at(table + i * 4)).collect();
        (0..count).map(|i| {
            let end = offs.get(i + 1).copied().unwrap_or(table);
            read_book(&mut Reader { d: &BOOKS[offs[i]..end], pos: 0 }, true).ok()
        }).collect()
    })
}

/// The setup packet in Wwise's stripped form, plus each mode's long-block flag. Same field widths as standard Vorbis
/// except: codebooks become table indices, no time domain, no floor type, a 2-bit residue type, no mapping type, no
/// mode window or transform type, no framing bit.
fn wwise_setup(packet: &[u8], channels: i64) -> Result<(Vec<u8>, Vec<bool>), String> {
    let r = &mut Reader { d: packet, pos: 0 };
    let w = &mut Writer::default();
    if r.read(8)? != 5 || (0..6).map(|_| r.read(8)).collect::<Result<Vec<_>, _>>()? != b"vorbis".map(u32::from) {
        return Err("not a Vorbis setup packet".into());
    }
    let books = r.int(8)? + 1;
    w.write(books - 1, 8);
    for _ in 0..books {
        let b = read_book(r, false)?;
        let i = library().iter().position(|l| l.as_ref() == Some(&b))
            .ok_or_else(|| format!("codebook ({} dims, {} entries) is not in the Wwise table", b.dims, b.entries))?;
        w.write(i as i64, 10);
    }
    for _ in 0..r.int(6)? + 1 { r.read(16)?; } // time domain, dropped
    // every other field is copied with its width, so a small copier keeps the layout readable
    macro_rules! copy { ($bits:expr) => {{ let b = $bits; let v = r.int(b)?; w.write(v, b); v }} }
    let floors = copy!(6) + 1;
    for _ in 0..floors {
        if r.read(16)? != 1 { return Err("only floor type 1 is supported".into()) }
        let parts = copy!(5);
        let classes: Vec<i64> = (0..parts).map(|_| Ok::<_, String>(copy!(4))).collect::<Result<_, _>>()?;
        let max = classes.iter().copied().max().unwrap_or(-1);
        let mut dims = vec![];
        for _ in 0..=max {
            dims.push(copy!(3) + 1);
            let sub = copy!(2);
            if sub != 0 { copy!(8); }
            for _ in 0..1 << sub { copy!(8); }
        }
        copy!(2);
        let range = copy!(4) as u32;
        for c in &classes { for _ in 0..dims[*c as usize] { copy!(range); } }
    }
    let residues = copy!(6) + 1;
    for _ in 0..residues {
        let t = r.int(16)?;
        w.write(t, 2);
        copy!(24); copy!(24); copy!(24);
        let n = copy!(6) + 1;
        copy!(8);
        let mut cascade = vec![];
        for _ in 0..n {
            let low = copy!(3);
            let high = if copy!(1) != 0 { copy!(5) } else { 0 };
            cascade.push(high << 3 | low);
        }
        for c in cascade { for j in 0..8 { if c & 1 << j != 0 { copy!(8); } } }
    }
    let mappings = copy!(6) + 1;
    for _ in 0..mappings {
        if r.read(16)? != 0 { return Err("only mapping type 0 is supported".into()) }
        let submaps = if copy!(1) != 0 { copy!(4) + 1 } else { 1 };
        if copy!(1) != 0 {
            let steps = copy!(8) + 1;
            let bits = ilog(channels - 1);
            for _ in 0..steps { copy!(bits); copy!(bits); }
        }
        if copy!(2) != 0 { return Err("mapping reserved bits set".into()) }
        if submaps > 1 { for _ in 0..channels { copy!(4); } }
        for _ in 0..submaps { copy!(8); copy!(8); copy!(8); }
    }
    let modes = copy!(6) + 1;
    let mut flags = vec![];
    for _ in 0..modes {
        flags.push(copy!(1) != 0);
        if r.read(16)? != 0 || r.read(16)? != 0 { return Err("non-zero window or transform type".into()) }
        copy!(8);
    }
    Ok((std::mem::take(&mut w.bytes), flags))
}

/// Ogg pages back into whole packets (a packet may span pages).
fn demux(ogg: &[u8]) -> Vec<Vec<u8>> {
    let (mut out, mut cur, mut p) = (vec![], vec![], 0usize);
    while p + 27 <= ogg.len() && &ogg[p..p + 4] == b"OggS" {
        let segs = ogg[p + 26] as usize;
        let mut at = p + 27 + segs;
        for i in 0..segs {
            let len = ogg[p + 27 + i] as usize;
            cur.extend_from_slice(&ogg[at..(at + len).min(ogg.len())]);
            at += len;
            if len < 255 { out.push(std::mem::take(&mut cur)) }
        }
        p = at;
    }
    if !cur.is_empty() { out.push(cur) }
    out
}

/// `pcm` interleaved 16-bit, mono or stereo. Returns the .wem bytes.
pub fn encode(pcm: &[i16], rate: u32, channels: u16) -> Result<Vec<u8>, String> {
    if !(channels == 1 || channels == 2) { return Err("mono or stereo only".into()) }
    let ch = channels as usize;
    let frames = pcm.len() / ch;
    if frames == 0 { return Err("the sound is empty".into()) }
    let mut ogg = Vec::new();
    {
        let mut enc = vorbis_rs::VorbisEncoderBuilder::new_with_serial(
            NonZeroU32::new(rate).ok_or("no sample rate")?, NonZeroU8::new(channels as u8).unwrap(), &mut ogg, 1)
            .bitrate_management_strategy(vorbis_rs::VorbisBitrateManagementStrategy::QualityVbr { target_quality: QUALITY })
            .build().map_err(|e| e.to_string())?;
        for chunk in pcm.chunks(512 * ch) {
            let planes: Vec<Vec<f32>> = (0..ch).map(|c| chunk.iter().skip(c).step_by(ch).map(|&s| s as f32 / 32768.0).collect()).collect();
            enc.encode_audio_block(&planes).map_err(|e| e.to_string())?;
        }
        enc.finish().map_err(|e| e.to_string())?;
    }
    let packets = demux(&ogg);
    if packets.len() < 3 || packets[0].len() < 29 { return Err("the encoder made no Vorbis headers".into()) }
    let (setup, flags) = wwise_setup(&packets[2], ch as i64)?;
    let (bs0, bs1) = (packets[0][28] & 0x0f, packets[0][28] >> 4);
    let mode_bits = ilog(flags.len() as i64 - 1);
    let audio: Vec<&Vec<u8>> = packets[3..].iter().filter(|p| !p.is_empty()).collect();

    // the seek table: (samples, bytes) per ~16k-sample block, the trailing partial block left out
    let mut seek = vec![];
    let (mut s, mut b, mut prev) = (0u32, 0u32, 0u32);
    let mut stored = vec![];
    for p in &audio {
        let r = &mut Reader { d: p, pos: 0 };
        if r.read(1)? != 0 { return Err("an audio packet did not start with a zero type bit".into()) }
        let mode = r.read(mode_bits)? as usize;
        let long = *flags.get(mode).ok_or("bad mode number")?;
        let size = 1u32 << if long { bs1 } else { bs0 };
        if prev != 0 { s += (prev + size) / 4 }
        prev = size;
        b += 2 + p.len() as u32;
        if s >= SEEK_BLOCK {
            seek.extend_from_slice(&(s.min(65535) as u16).to_le_bytes());
            seek.extend_from_slice(&(b.min(65535) as u16).to_le_bytes());
            s = 0;
            b = 0;
        }
        // Wwise drops the type bit and, on long blocks, the two window flags
        if long { r.read(2)?; }
        let w = &mut Writer::default();
        w.write(mode as i64, mode_bits);
        for i in r.pos..p.len() * 8 { w.write(((p[i >> 3] >> (i & 7)) & 1) as i64, 1) }
        stored.push(std::mem::take(&mut w.bytes));
    }
    let mut data = seek.clone();
    let setup_at = data.len() as u32;
    data.extend_from_slice(&(setup.len() as u16).to_le_bytes());
    data.extend_from_slice(&setup);
    let audio_at = data.len() as u32;
    let mut max_packet = 0usize;
    for p in &stored {
        if p.len() > 65535 { return Err("an audio packet is too large".into()) }
        data.extend_from_slice(&(p.len() as u16).to_le_bytes());
        data.extend_from_slice(p);
        max_packet = max_packet.max(p.len());
    }

    let mut ext = [0u8; 48];
    let mut put = |o: usize, v: u32| ext[o..o + 4].copy_from_slice(&v.to_le_bytes());
    put(0x02, if ch == 1 { 0x4101 } else { 0x3102 });
    put(0x06, frames as u32);
    put(0x0a, 2 + setup.len() as u32);
    put(0x0e, (data.len() - seek.len()) as u32);
    put(0x16, setup_at);
    put(0x1a, audio_at);
    ext[0x1e..0x20].copy_from_slice(&(max_packet as u16).to_le_bytes());
    ext[0x2e] = bs0;
    ext[0x2f] = bs1;

    let mut out = Vec::with_capacity(data.len() + 118);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((12 + 74 + 24 + 8 + data.len() - 8) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&66u32.to_le_bytes());
    out.extend_from_slice(&0xFFFFu16.to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&((data.len() as u64 * rate as u64 / frames as u64) as u32).to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]); // block align and bits, unused
    out.extend_from_slice(&48u16.to_le_bytes());
    out.extend_from_slice(&ext);
    out.extend_from_slice(b"hash");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&md5(&data));
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(&data);
    Ok(out)
}

/// The "hash" chunk shipped files carry (MD5 of the data chunk), RFC 1321.
fn md5(input: &[u8]) -> [u8; 16] {
    const S: [u32; 64] = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    let k: Vec<u32> = (0..64).map(|i| ((i as f64 + 1.0).sin().abs() * 4294967296.0) as u32).collect();
    let mut msg = input.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 { msg.push(0) }
    msg.extend_from_slice(&((input.len() as u64) * 8).to_le_bytes());
    let mut h = [0x67452301u32, 0xefcdab89, 0x98badcfe, 0x10325476];
    for block in msg.chunks(64) {
        let m: Vec<u32> = block.chunks(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
        let [mut a, mut b, mut c, mut d] = h;
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let t = d;
            d = c;
            c = b;
            b = b.wrapping_add(a.wrapping_add(f).wrapping_add(k[i]).wrapping_add(m[g]).rotate_left(S[i]));
            a = t;
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d]) { *x = x.wrapping_add(y) }
    }
    let mut out = [0u8; 16];
    for (i, x) in h.iter().enumerate() { out[i * 4..i * 4 + 4].copy_from_slice(&x.to_le_bytes()) }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md5_matches_rfc_vectors() {
        let hex = |b: [u8; 16]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        assert_eq!(hex(md5(b"")), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(hex(md5(b"The quick brown fox jumps over the lazy dog")), "9e107d9d372bb6826bd81d3542a419d6");
    }

    #[test]
    fn table_loads_and_encodes_mono_and_stereo() {
        assert!(library().iter().filter(|b| b.is_some()).count() > 500, "the codebook table did not parse");
        for (rate, ch) in [(48000u32, 2u16), (48000, 1), (44100, 2), (22050, 1)] {
            let n = rate as usize; // one second
            let pcm: Vec<i16> = (0..n * ch as usize).map(|i| ((i as f32 * 0.05).sin() * 12000.0) as i16).collect();
            let wem = encode(&pcm, rate, ch).unwrap_or_else(|e| panic!("{rate} Hz x{ch}: {e}"));
            assert_eq!(&wem[0..4], b"RIFF");
            assert_eq!(u16::from_le_bytes([wem[20], wem[21]]), 0xFFFF);
            assert_eq!(u32::from_le_bytes(wem[38 + 6..38 + 10].try_into().unwrap()), n as u32, "total frames");
            assert_ne!(u16::from_le_bytes([wem[38 + 0x1e], wem[38 + 0x1f]]), 0, "uMaxPacketSize must be set");
        }
        // the Sounds tab's shortest built-in sound (Soft tick) is 0.05 s
        let tick: Vec<i16> = (0..2400).map(|i| ((i as f32 * 0.3).sin() * 9000.0) as i16).collect();
        let wem = encode(&tick, 48000, 1).unwrap();
        assert_eq!(u32::from_le_bytes(wem[38 + 6..38 + 10].try_into().unwrap()), 2400, "total frames of a short sound");
    }
}
