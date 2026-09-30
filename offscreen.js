// Three-note rising chime, played twice so it's hard to miss.
const playChime = () => {
    const ctx = new AudioContext();
    const notes = [659.25, 830.61, 987.77];
    [0, 0.9].forEach((repeatAt) => {
        notes.forEach((freq, i) => {
            const start = ctx.currentTime + repeatAt + i * 0.16;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.5, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.6);
            osc.connect(gain).connect(ctx.destination);
            osc.start(start);
            osc.stop(start + 0.65);
        });
    });
    setTimeout(() => ctx.close(), 2500);
};

chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'play-chime') playChime();
});
