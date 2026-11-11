(() => {
  const pads = [...document.querySelectorAll('.sound-pad')];
  const knobs = [...document.querySelectorAll('.knob')];
  const visualizer = document.getElementById('visualizer');
  const activeCount = document.getElementById('activeCount');
  const sessionLed = document.getElementById('sessionLed');
  const sessionStatus = document.getElementById('sessionStatus');
  const screenMessage = document.getElementById('screenMessage');
  const clockDisplay = document.getElementById('clockDisplay');
  const toast = document.getElementById('toast');

  const settings = { reverb: 32, delay: 18, tempo: 84 };
  const active = new Map();
  let audio = null;
  let nextBeat = 0;
  let beatNumber = 0;
  let scheduler = null;
  let startedAt = 0;
  let toastTimer = 0;
  let masterMuted = false;

  function makeNoiseBuffer(ctx, seconds = 2.6, color = 'white') {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      if (color === 'pink') {
        last = last * 0.94 + white * 0.06;
        data[i] = last * 2.4 + white * 0.32;
      } else {
        data[i] = white;
      }
    }
    // A very short edge fade avoids a hard click as the texture loops.
    const fade = Math.floor(ctx.sampleRate * 0.018);
    for (let i = 0; i < fade; i++) {
      const gain = i / fade;
      data[i] *= gain;
      data[length - 1 - i] *= gain;
    }
    return buffer;
  }

  function makeImpulse(ctx, seconds = 2.8) {
    const length = Math.floor(ctx.sampleRate * seconds);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        const fade = Math.pow(1 - i / length, 2.5);
        data[i] = (Math.random() * 2 - 1) * fade;
      }
    }
    return impulse;
  }

  function initAudio() {
    if (audio) {
      if (audio.ctx.state === 'suspended') audio.ctx.resume();
      return;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      showToast('This browser does not support audio playback');
      return;
    }
    const ctx = new AudioCtx();
    const master = ctx.createGain();
    master.gain.value = masterMuted ? 0 : 0.43;
    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(ctx);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = settings.reverb / 100 * 0.48;
    const delay = ctx.createDelay(1.5);
    delay.delayTime.value = 60 / settings.tempo * 0.75;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.18;
    const delayReturn = ctx.createGain();
    delayReturn.gain.value = settings.delay / 100 * 0.54;
    const sendBus = ctx.createGain();
    sendBus.gain.value = 1;

    reverb.connect(reverbReturn);
    reverbReturn.connect(master);
    delay.connect(delayReturn);
    delayReturn.connect(master);
    delay.connect(feedback);
    feedback.connect(delay);
    sendBus.connect(reverb);
    sendBus.connect(delay);
    master.connect(ctx.destination);

    audio = { ctx, master, reverbReturn, delay, feedback, delayReturn, sendBus, buffers: {
      pink: makeNoiseBuffer(ctx, 3.2, 'pink'),
      white: makeNoiseBuffer(ctx, 2.1, 'white'),
    }};
    nextBeat = ctx.currentTime + 0.08;
    scheduler = window.setInterval(tick, 25);
  }

  function connectVoice(source, voice, sendAmount = 0.35) {
    const send = audio.ctx.createGain();
    send.gain.value = sendAmount;
    source.connect(voice.gain);
    source.connect(send);
    send.connect(audio.sendBus);
  }

  function buildVoice(name) {
    const { ctx, buffers } = audio;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(audio.master);
    const voice = { gain, sources: [], started: false, name };
    const noise = (buffer, filterType, frequency, q = 0.3, volume = 0.24, send = 0.32) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = filterType;
      filter.frequency.value = frequency;
      filter.Q.value = q;
      source.connect(filter);
      const level = ctx.createGain();
      level.gain.value = volume;
      filter.connect(level);
      connectVoice(level, voice, send);
      voice.sources.push(source);
    };
    const tone = (frequency, volume, wave = 'sine', detune = 0, send = 0.45) => {
      const osc = ctx.createOscillator();
      osc.type = wave;
      osc.frequency.value = frequency;
      osc.detune.value = detune;
      const level = ctx.createGain();
      level.gain.value = volume;
      connectVoice(osc, voice, send);
      osc.connect(level);
      // connectVoice routes the oscillator directly too; use an attenuated node instead.
      // Rewire the dry path through the level so the voice remains gentle.
      osc.disconnect();
      osc.connect(level);
      const sendNode = ctx.createGain();
      sendNode.gain.value = send;
      level.connect(voice.gain);
      level.connect(sendNode);
      sendNode.connect(audio.sendBus);
      voice.sources.push(osc);
      return osc;
    };

    if (name === 'rain') {
      noise(buffers.pink, 'lowpass', 2400, 0.2, 0.29, 0.42);
      noise(buffers.white, 'highpass', 2100, 0.3, 0.035, 0.34);
    } else if (name === 'wind') {
      noise(buffers.pink, 'lowpass', 480, 0.65, 0.38, 0.55);
      const osc = tone(72, 0.012, 'sine', -4, 0.5);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.12;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 65;
      lfo.connect(lfoGain);
      lfoGain.connect(voice.sources[0]?.frequency || osc.frequency);
      lfo.start();
      voice.sources.push(lfo);
    } else if (name === 'birds') {
      // A low, airy bed sits under short, beat-quantized synthetic bird calls.
      noise(buffers.pink, 'lowpass', 1500, 0.25, 0.07, 0.38);
    } else if (name === 'paper') {
      noise(buffers.white, 'bandpass', 1900, 0.8, 0.06, 0.26);
    } else if (name === 'bubbles') {
      noise(buffers.pink, 'lowpass', 620, 0.5, 0.08, 0.48);
    } else if (name === 'vinyl') {
      noise(buffers.pink, 'lowpass', 3400, 0.15, 0.10, 0.23);
      noise(buffers.white, 'highpass', 4300, 0.2, 0.008, 0.18);
    }
    return voice;
  }

  function startVoice(name, when) {
    const voice = buildVoice(name);
    const ctx = audio.ctx;
    voice.sources.forEach(source => {
      try { source.start(when); } catch (_) { /* already stopped */ }
    });
    voice.gain.gain.cancelScheduledValues(ctx.currentTime);
    voice.gain.gain.setValueAtTime(0, Math.max(ctx.currentTime, when - 0.035));
    voice.gain.gain.linearRampToValueAtTime(1, when + 0.16);
    voice.started = true;
    return voice;
  }

  function stopVoice(voice, when) {
    if (!voice || !audio) return;
    const ctx = audio.ctx;
    voice.gain.gain.cancelScheduledValues(ctx.currentTime);
    const now = Math.max(ctx.currentTime, when);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + 0.18);
    voice.sources.forEach(source => {
      try { source.stop(now + 0.21); } catch (_) { /* source can have already ended */ }
    });
  }

  function triggerChirp(at, name) {
    if (!audio) return;
    const { ctx } = audio;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    const send = ctx.createGain();
    const base = name === 'birds' ? 1000 + Math.random() * 600 : 250 + Math.random() * 200;
    const duration = name === 'birds' ? 0.19 : 0.24;
    osc.type = name === 'birds' ? 'sine' : 'sine';
    osc.frequency.setValueAtTime(base, at);
    osc.frequency.exponentialRampToValueAtTime(name === 'birds' ? base * (0.62 + Math.random() * 0.18) : base * 2.5, at + duration);
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(name === 'birds' ? 0.045 : 0.055, at + 0.025);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    send.gain.value = name === 'birds' ? 0.42 : 0.55;
    osc.connect(env);
    env.connect(audio.master);
    env.connect(send);
    send.connect(audio.sendBus);
    osc.start(at);
    osc.stop(at + duration + 0.03);
  }

  function triggerCrinkle(at) {
    if (!audio) return;
    const { ctx, buffers } = audio;
    const source = ctx.createBufferSource();
    source.buffer = buffers.white;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2200 + Math.random() * 1600;
    filter.Q.value = 0.8;
    const env = ctx.createGain();
    const send = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(0.065, at + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.11);
    send.gain.value = 0.28;
    source.connect(filter);
    filter.connect(env);
    env.connect(audio.master);
    env.connect(send);
    send.connect(audio.sendBus);
    source.start(at);
    source.stop(at + 0.13);
  }

  function tick() {
    if (!audio) return;
    const ctx = audio.ctx;
    if (ctx.state !== 'running') return;
    const interval = 60 / settings.tempo;
    while (nextBeat < ctx.currentTime + 0.12) {
      beatNumber++;
      active.forEach((voice, name) => {
        if (!voice.started) return;
        if (name === 'birds' && beatNumber % 2 === 0) triggerChirp(nextBeat, name);
        if (name === 'bubbles' && beatNumber % 2 === 1) triggerChirp(nextBeat, name);
        if (name === 'paper' && beatNumber % 4 === 1) triggerCrinkle(nextBeat + 0.015);
      });
      nextBeat += interval;
    }
  }

  function nextGridTime() {
    if (!audio) return 0;
    const now = audio.ctx.currentTime;
    return nextBeat > now + 0.015 ? nextBeat : now + 0.03;
  }

  function updatePad(name, enabled) {
    const pad = pads.find(item => item.dataset.sound === name);
    if (!pad) return;
    pad.classList.toggle('active', enabled);
    pad.setAttribute('aria-pressed', String(enabled));
    pad.querySelector('.pad-status').innerHTML = `<i></i>${enabled ? 'ON' : 'OFF'}`;
  }

  async function togglePad(name) {
    initAudio();
    if (!audio) return;
    try { await audio.ctx.resume(); } catch (_) { showToast('Tap again to allow audio'); return; }
    const when = nextGridTime();
    if (active.has(name)) {
      const voice = active.get(name);
      active.delete(name);
      stopVoice(voice, when);
      updatePad(name, false);
    } else {
      const voice = startVoice(name, when);
      active.set(name, voice);
      updatePad(name, true);
    }
    updateInterface();
  }

  function updateInterface() {
    const count = active.size;
    activeCount.textContent = String(count).padStart(2, '0');
    visualizer.classList.toggle('playing', count > 0);
    sessionLed.classList.toggle('live', count > 0);
    sessionStatus.textContent = count ? 'IN THE GROOVE' : 'READY TO PLAY';
    screenMessage.textContent = count ? `${count} ${count === 1 ? 'sound' : 'sounds'} in the mix  ·  ${settings.tempo} BPM` : 'tap a sound to begin';
    if (count && !startedAt) startedAt = Date.now();
    if (!count) startedAt = 0;
  }

  function setKnob(knob, value) {
    const key = knob.dataset.control;
    const min = key === 'tempo' ? 60 : 0;
    const max = key === 'tempo' ? 140 : 100;
    value = Math.max(min, Math.min(max, Math.round(value)));
    settings[key] = value;
    const normalized = (value - min) / (max - min);
    const angle = -135 + normalized * 270;
    knob.style.setProperty('--angle', `${angle}deg`);
    knob.setAttribute('aria-valuenow', String(value));
    if (key === 'tempo') {
      document.getElementById('tempoValue').innerHTML = `${value} <small>BPM</small>`;
      if (audio) audio.delay.delayTime.setTargetAtTime(60 / value * 0.75, audio.ctx.currentTime, 0.08);
    } else if (key === 'reverb') {
      document.getElementById('reverbValue').textContent = `${value}%`;
      if (audio) audio.reverbReturn.gain.setTargetAtTime(value / 100 * 0.48, audio.ctx.currentTime, 0.08);
    } else {
      document.getElementById('delayValue').textContent = `${value}%`;
      if (audio) {
        audio.delayReturn.gain.setTargetAtTime(value / 100 * 0.54, audio.ctx.currentTime, 0.08);
        audio.feedback.gain.setTargetAtTime(0.1 + value / 100 * 0.48, audio.ctx.currentTime, 0.08);
      }
    }
    if (active.size) screenMessage.textContent = `${active.size} ${active.size === 1 ? 'sound' : 'sounds'} in the mix  ·  ${settings.tempo} BPM`;
  }

  knobs.forEach(knob => {
    const key = knob.dataset.control;
    setKnob(knob, settings[key]);
    let pointerStart = null;
    knob.addEventListener('pointerdown', event => {
      event.preventDefault();
      knob.setPointerCapture(event.pointerId);
      pointerStart = { y: event.clientY, value: settings[key], moved: false };
    });
    knob.addEventListener('pointermove', event => {
      if (!pointerStart) return;
      const delta = pointerStart.y - event.clientY;
      if (Math.abs(delta) > 2) pointerStart.moved = true;
      if (pointerStart.moved) setKnob(knob, pointerStart.value + delta * (key === 'tempo' ? 0.55 : 0.8));
    });
    knob.addEventListener('pointerup', event => {
      if (!pointerStart) return;
      if (!pointerStart.moved) {
        const rect = knob.getBoundingClientRect();
        const angle = Math.atan2(event.clientY - (rect.top + rect.height / 2), event.clientX - (rect.left + rect.width / 2)) * 180 / Math.PI + 90;
        const clamped = Math.max(-135, Math.min(135, angle));
        const min = key === 'tempo' ? 60 : 0;
        const max = key === 'tempo' ? 140 : 100;
        setKnob(knob, min + (clamped + 135) / 270 * (max - min));
      }
      pointerStart = null;
    });
    knob.addEventListener('pointercancel', () => { pointerStart = null; });
    knob.addEventListener('wheel', event => {
      event.preventDefault();
      setKnob(knob, settings[key] + (event.deltaY < 0 ? 2 : -2));
    }, { passive: false });
    knob.addEventListener('keydown', event => {
      if (!['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const min = key === 'tempo' ? 60 : 0;
      const max = key === 'tempo' ? 140 : 100;
      if (event.key === 'Home') setKnob(knob, min);
      else if (event.key === 'End') setKnob(knob, max);
      else setKnob(knob, settings[key] + (['ArrowUp', 'ArrowRight'].includes(event.key) ? 1 : -1));
    });
  });

  pads.forEach(pad => pad.addEventListener('click', () => togglePad(pad.dataset.sound)));
  document.getElementById('volumeButton').addEventListener('click', event => {
    masterMuted = !masterMuted;
    event.currentTarget.setAttribute('aria-pressed', String(masterMuted));
    event.currentTarget.setAttribute('aria-label', masterMuted ? 'Unmute master volume' : 'Mute master volume');
    event.currentTarget.querySelector('.volume-icon').textContent = masterMuted ? '×' : '◖';
    if (audio) audio.master.gain.setTargetAtTime(masterMuted ? 0 : 0.43, audio.ctx.currentTime, 0.04);
    showToast(masterMuted ? 'Master muted' : 'Master volume on');
  });

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2200);
  }

  const modal = document.getElementById('helpModal');
  const closeHelp = () => { modal.hidden = true; };
  document.getElementById('helpButton').addEventListener('click', () => { modal.hidden = false; document.getElementById('closeHelp').focus(); });
  document.getElementById('closeHelp').addEventListener('click', closeHelp);
  document.getElementById('gotIt').addEventListener('click', closeHelp);
  modal.addEventListener('click', event => { if (event.target === modal) closeHelp(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeHelp(); });

  window.setInterval(() => {
    if (!startedAt) { clockDisplay.textContent = '00 : 00'; return; }
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    clockDisplay.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')} : ${String(seconds % 60).padStart(2, '0')}`;
  }, 500);
})();
