// Three-note rising chime, played once.
const playChime = async () => {
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const notes = [659.25, 830.61, 987.77];
    notes.forEach((freq, i) => {
        const start = ctx.currentTime + i * 0.16;
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
    setTimeout(() => ctx.close(), 1500);
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== 'play-chime') return;
    playChime()
        .then(() => sendResponse({ played: true }))
        .catch((error) => sendResponse({ played: false, error: error.message }));
    return true;
});
