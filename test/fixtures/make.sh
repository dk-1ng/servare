#!/usr/bin/env bash
# Generates every synthetic media fixture with FFmpeg into test/fixtures/out/.
# Sources are FFmpeg's built-in generators only (testsrc2, sine, hand-written WebVTT).
# Nothing here downloads or embeds third-party media. Usage: test/fixtures/make.sh (always rebuilds out/ from scratch)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/out"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "make.sh: ffmpeg not found in PATH; cannot generate fixtures" >&2
  exit 2
fi

rm -rf "$OUT"
mkdir -p "$OUT"
cd "$OUT"

DUR=6 # seconds of media per fixture
SEG=2 # HLS/DASH segment duration in seconds
FF=(ffmpeg -hide_banner -loglevel error -nostdin -y -fflags +bitexact -flags:v +bitexact -flags:a +bitexact)

# Synthetic inputs: a test pattern with a running timecode and a fixed-frequency tone.
VSRC=(-f lavfi -i "testsrc2=size=320x240:rate=15:duration=$DUR")
VSRC_SMALL=(-f lavfi -i "testsrc2=size=160x120:rate=15:duration=$DUR")
ASRC=(-f lavfi -i "sine=frequency=440:sample_rate=48000:duration=$DUR")
ASRC_B=(-f lavfi -i "sine=frequency=660:sample_rate=48000:duration=$DUR")

H264=(-c:v libx264 -preset veryfast -profile:v main -pix_fmt yuv420p -g 30 -keyint_min 30 -sc_threshold 0)
AAC=(-c:a aac -b:a 64k -ar 48000 -ac 2)
VP9=(-c:v libvpx-vp9 -b:v 300k -deadline realtime -cpu-used 8 -g 30 -pix_fmt yuv420p)
OPUS=(-c:a libopus -b:a 48k)

echo "==> mp4 / webm"
"${FF[@]}" "${VSRC[@]}" "${ASRC[@]}" "${H264[@]}" "${AAC[@]}" -movflags +faststart -shortest sample.mp4
"${FF[@]}" "${VSRC[@]}" "${ASRC[@]}" "${VP9[@]}" "${OPUS[@]}" -shortest sample.webm

# --- HLS -------------------------------------------------------------------
hls_args=(-f hls -hls_time "$SEG" -hls_playlist_type vod -hls_flags independent_segments)

echo "==> hls multi-variant (two renditions, MPEG-TS)"
mkdir -p hls/variants
(
  cd hls/variants
  "${FF[@]}" "${VSRC[@]}" "${ASRC[@]}" "${H264[@]}" "${AAC[@]}" -shortest "${hls_args[@]}" \
    -hls_segment_filename 'hi_%03d.ts' hi.m3u8
  "${FF[@]}" "${VSRC_SMALL[@]}" "${ASRC[@]}" "${H264[@]}" -b:v 100k "${AAC[@]}" -shortest \
    "${hls_args[@]}" -hls_segment_filename 'lo_%03d.ts' lo.m3u8
  cat > master.m3u8 <<'M'
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=320x240,CODECS="avc1.4d4015,mp4a.40.2"
hi.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x120,CODECS="avc1.4d400c,mp4a.40.2"
lo.m3u8
M
)

echo "==> hls fMP4 (CMAF-style segments)"
mkdir -p hls/fmp4
(
  cd hls/fmp4
  "${FF[@]}" "${VSRC[@]}" "${ASRC[@]}" "${H264[@]}" "${AAC[@]}" -shortest "${hls_args[@]}" \
    -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 \
    -hls_segment_filename 'seg_%03d.m4s' index.m3u8
)

# Fixed, public, throwaway key: it protects nothing and exists only to exercise AES-128-CBC.
KEY_HEX="000102030405060708090a0b0c0d0e0f"
IV_HEX="a0a1a2a3a4a5a6a7a8a9aaabacadaeaf"

make_encrypted() { # <dir> <with-iv: yes|no>
  local dir="$1" with_iv="$2"
  mkdir -p "hls/$dir"
  (
    cd "hls/$dir"
    printf '%s' "$KEY_HEX" | xxd -r -p > key.bin
    {
      echo "key.bin"
      echo "key.bin"
      if [[ "$with_iv" == "yes" ]]; then echo "$IV_HEX"; fi
    } > keyinfo.txt
    "${FF[@]}" "${VSRC[@]}" "${ASRC[@]}" "${H264[@]}" "${AAC[@]}" -shortest "${hls_args[@]}" \
      -hls_key_info_file keyinfo.txt -hls_segment_filename 'seg_%03d.ts' index.m3u8
    if [[ "$with_iv" == "no" ]]; then
      # FFmpeg always writes an IV attribute; drop it so the playlist relies on the
      # implicit IV (media sequence number, RFC 8216 section 5.2). Segments were
      # encrypted with that very IV when keyinfo.txt carries none.
      sed -i 's/,IV=0x[0-9a-fA-F]*//' index.m3u8
    fi
  )
}
echo "==> hls AES-128 with explicit IV"
make_encrypted aes128-iv yes
echo "==> hls AES-128 without IV (IV = media sequence number)"
make_encrypted aes128-noiv no

echo "==> hls alternate audio + WebVTT subtitles"
mkdir -p hls/alt
(
  cd hls/alt
  cat > subs.vtt <<'V'
WEBVTT

00:00:00.000 --> 00:00:02.000
First synthetic cue

00:00:02.000 --> 00:00:04.000
Second synthetic cue

00:00:04.000 --> 00:00:06.000
Third synthetic cue
V
  "${FF[@]}" "${VSRC[@]}" "${H264[@]}" -an "${hls_args[@]}" -hls_segment_filename 'video_%03d.ts' video.m3u8
  "${FF[@]}" "${ASRC[@]}" "${AAC[@]}" "${hls_args[@]}" -hls_segment_filename 'audio_en_%03d.ts' audio_en.m3u8
  "${FF[@]}" "${ASRC_B[@]}" "${AAC[@]}" "${hls_args[@]}" -hls_segment_filename 'audio_pt_%03d.ts' audio_pt.m3u8
  # A subtitle playlist with one whole-file WebVTT segment (valid per RFC 8216 section 4.3.2.1).
  cat > subs.m3u8 <<'S'
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:6.000,
subs.vtt
#EXT-X-ENDLIST
S
  cat > master.m3u8 <<'M'
#EXTM3U
#EXT-X-VERSION:4
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio_en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Portuguese",LANGUAGE="pt",DEFAULT=NO,AUTOSELECT=YES,URI="audio_pt.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="subs.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=320x240,CODECS="avc1.4d4015,mp4a.40.2",AUDIO="aud",SUBTITLES="sub"
video.m3u8
M
)

# --- DASH ------------------------------------------------------------------
echo "==> dash H.264 / AAC"
mkdir -p dash/h264
(
  cd dash/h264
  "${FF[@]}" "${VSRC[@]}" "${ASRC[@]}" "${H264[@]}" "${AAC[@]}" -shortest \
    -f dash -seg_duration "$SEG" -use_template 1 -use_timeline 1 \
    -init_seg_name 'init-$RepresentationID$.m4s' -media_seg_name 'chunk-$RepresentationID$-$Number%05d$.m4s' \
    -adaptation_sets "id=0,streams=v id=1,streams=a" manifest.mpd
)

echo "==> dash VP9 / Opus (WebM)"
mkdir -p dash/vp9
(
  cd dash/vp9
  "${FF[@]}" "${VSRC[@]}" "${ASRC[@]}" "${VP9[@]}" "${OPUS[@]}" -shortest \
    -f dash -seg_duration "$SEG" -use_template 1 -use_timeline 1 \
    -init_seg_name 'init-$RepresentationID$.webm' -media_seg_name 'chunk-$RepresentationID$-$Number%05d$.webm' \
    -adaptation_sets "id=0,streams=v id=1,streams=a" manifest.mpd
)

echo "fixtures written to $OUT"
