ChartBridge's voice calls: voice 4 (Sonia, crisp agentic)

What: the nine calls ChartBridge can say (nt8/ChartBridge.cs, ChartBridgeVoice; the bot's BotNotClosed in nt8/ChartBridgeBot.cs).
They install with the page (nt8/install-files.json) into ChartBridge's www\voice, ChartBridge's default voice folder since
release 1 (a voiceFolder line in config.txt still wins). They play only with voice = on in config.txt (off by default).

Source: Microsoft's Sonia neural voice (en-GB-SoniaNeural) through edge-tts, then an assistant-style effect, made on HOME on
2026-11-03 as "voice 4", the set Anthony picked that day (Drive TradingApp_Handoff, FROM_HOME_2026-11-03_nt_voice_set,
voice4_sonia_crisp_agentic, with its generator make_voice_sets.py and voice_fx.py). Anthony's ruling of 2026-11-18: the set
ships in this public repo, knowing the edge-tts terms are unclear.

Settings (voice 4): voice en-GB-SoniaNeural, rate +6%, pitch +0Hz; effect preset flange 0.42, double 0.18, room 0.08,
ring 0.22 (voice_fx.assistant_fx: a faint 42 Hz ring-modulated copy, a slow 1.5 to 4.5 ms flanger, a detuned double 14 ms
late, a 90 Hz high-pass, presence and air lifts, a short seeded room, 0.3 s of tail, peak at 0.89); the lead silence trimmed
to 15 ms (make_voice_sets.trim_lead). Format: WAV, PCM, mono, 16-bit, 48000 Hz.

Made where:
- The first eight are byte-for-byte copies of HOME's set (their sha256 match HOME's README).
- BotNotClosed.wav was made in the cloud on 2026-11-18 with the same voice, settings and effect (HOME's two scripts, the
  voice-4 preset). One step differs: the MP3 from edge-tts was turned into a 48000 Hz mono 16-bit WAV with ffmpeg instead of
  HOME's mp3_to_wav.ps1. There is no reference copy of it; its peak (-1.0 dBFS) and loudness (about -17 dBFS RMS) sit with
  the others (-15.8 to -19.2 dBFS RMS). It is longer (3.0 s) because it says two sentences.

Files (name, words, bytes, sha256):
LongFilled.wav  "Long filled"  111766 bytes  sha256 ee2217552ecbc4a34063397cc06652a7cc806bedfb5430130d33fbe450794fe8
ShortFilled.wav  "Short filled"  114886 bytes  sha256 d7767f59d731b004015cd641f92116b61d31c024c697ea013911904a0ef72100
StopFilled.wav  "Stop filled."  116536 bytes  sha256 7973364dcb44db5e07360eced6132dbf228a6446e433f1fa43bd770ef5b631fc
TargetFilled.wav  "Target filled."  122696 bytes  sha256 17bd9d88abc96b69bff5efb399fb84bd97a11b979411e8be8aab8c334358e644
TargetOneFilled.wav  "Target one filled"  152418 bytes  sha256 592ef89a35a43e199141d31b08044d11a556e71fcaaa776bb52d73788c6bb0f9
TargetTwoFilled.wav  "Target two filled"  149882 bytes  sha256 e5ff9a7dab75dbcbae4a104f3ff0fb4e49dd765275579587bc2828641c4ad974
PositionClosed.wav  "Position closed"  139826 bytes  sha256 b9ec234c00b03830f0f0d5e847eaaccd78c17dd4ffd022383324cba8c8c392f0
BreakEvenSet.wav  "Break even set"  133502 bytes  sha256 b4d01d0ced814a3a2db856627bb8e4aea28257c288fb1f77787d9f7374e6e637
BotNotClosed.wav  "Bot not closed. Check NinjaTrader."  290140 bytes  sha256 266fe5bd515be293712ae79034fba1efd53260a4d6880ec6b87212a76e2f7e89
