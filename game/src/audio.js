// audio.js — all sound is synthesized with WebAudio: a sawtooth engine hum whose pitch
// follows speed, a two-tone police siren, noise-burst collision thuds and small UI
// jingles. No audio files exist. The context is created on the first user gesture
// (the start screen click), as browsers require.
'use strict';

NV.Sound = {
  ctx: null,
  master: null,
  muted: false,
  engineOsc: null,
  engineGain: null,
  engineFilter: null,
  sirenOsc: null,
  sirenGain: null,
  sirenLfo: null,

  init: function () {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
  },

  toggleMute: function () {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  },

  // Engine: one sawtooth through a lowpass, started/stopped with driving.
  engine: function (on, speed01, dt) {
    if (!this.ctx) return;
    if (on && !this.engineOsc) {
      this.engineOsc = this.ctx.createOscillator();
      this.engineOsc.type = 'sawtooth';
      this.engineFilter = this.ctx.createBiquadFilter();
      this.engineFilter.type = 'lowpass';
      this.engineGain = this.ctx.createGain();
      this.engineGain.gain.value = 0.0;
      this.engineOsc.connect(this.engineFilter);
      this.engineFilter.connect(this.engineGain);
      this.engineGain.connect(this.master);
      this.engineOsc.start();
    }
    if (this.engineOsc) {
      var t = this.ctx.currentTime;
      var target = on ? 0.05 + speed01 * 0.05 : 0.0;
      this.engineGain.gain.setTargetAtTime(target, t, 0.08);
      this.engineOsc.frequency.setTargetAtTime(55 + speed01 * 165, t, 0.05);
      this.engineFilter.frequency.setTargetAtTime(300 + speed01 * 900, t, 0.05);
      if (!on && this.engineGain.gain.value < 0.002) {
        // Let the gain envelope finish before tearing the nodes down.
        var osc = this.engineOsc;
        this.engineOsc = null;
        window.setTimeout(function () { try { osc.stop(); } catch (e) { /* already stopped */ } }, 250);
      }
    }
  },

  // Siren: square wave whose frequency an LFO sweeps between two tones.
  siren: function (on, volume) {
    if (!this.ctx) return;
    if (on && !this.sirenOsc) {
      this.sirenOsc = this.ctx.createOscillator();
      this.sirenOsc.type = 'triangle';
      this.sirenOsc.frequency.value = 800;
      this.sirenLfo = this.ctx.createOscillator();
      this.sirenLfo.type = 'square';
      this.sirenLfo.frequency.value = 0.7;
      var lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 160;
      this.sirenLfo.connect(lfoGain);
      lfoGain.connect(this.sirenOsc.frequency);
      this.sirenGain = this.ctx.createGain();
      this.sirenGain.gain.value = 0.0;
      this.sirenOsc.connect(this.sirenGain);
      this.sirenGain.connect(this.master);
      this.sirenOsc.start();
      this.sirenLfo.start();
    }
    if (this.sirenGain) {
      var target = on ? NV.clamp(volume, 0, 0.06) : 0.0;
      this.sirenGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.15);
      if (!on && target === 0) {
        var osc = this.sirenOsc, lfo = this.sirenLfo;
        this.sirenOsc = null; this.sirenLfo = null;
        window.setTimeout(function () {
          try { osc.stop(); lfo.stop(); } catch (e) { /* already stopped */ }
        }, 400);
      }
    }
  },

  // Thud: a short burst of filtered noise; intensity 0..1 scales volume and brightness.
  thud: function (intensity) {
    if (!this.ctx || this.muted) return;
    var dur = 0.12 + intensity * 0.1;
    var len = Math.floor(this.ctx.sampleRate * dur);
    var buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = this.ctx.createBufferSource();
    src.buffer = buffer;
    var filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 200 + intensity * 500;
    var gain = this.ctx.createGain();
    gain.gain.value = 0.15 + intensity * 0.4;
    src.connect(filter); filter.connect(gain); gain.connect(this.master);
    src.start();
  },

  // Two-note success jingle for mission rewards.
  jingle: function () {
    if (!this.ctx || this.muted) return;
    var notes = [523.25, 659.25, 783.99];
    for (var i = 0; i < notes.length; i++) {
      var osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = notes[i];
      var gain = this.ctx.createGain();
      var t0 = this.ctx.currentTime + i * 0.09;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
      osc.connect(gain); gain.connect(this.master);
      osc.start(t0); osc.stop(t0 + 0.3);
    }
  }
};
