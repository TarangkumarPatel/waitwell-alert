const DEFAULTS = { glow: true, sound: true, desktop: false, teams: false, teamsUrl: '' };
const status = document.getElementById('status');

chrome.storage.sync.get(DEFAULTS).then((settings) => {
    ['glow', 'sound', 'desktop', 'teams'].forEach((id) => { document.getElementById(id).checked = settings[id]; });
    document.getElementById('teamsUrl').value = settings.teamsUrl;
});

chrome.storage.local.get(['lastAlert', 'lastError']).then(({ lastAlert, lastError }) => {
    const parts = [];
    if (lastAlert) parts.push(`Last alert: ${lastAlert.text} (${new Date(lastAlert.at).toLocaleTimeString()})`);
    if (lastError) parts.push(`Last error: ${lastError}`);
    document.getElementById('last').textContent = parts.join(' — ');
});

['glow', 'sound', 'desktop', 'teams'].forEach((id) => {
    document.getElementById(id).addEventListener('change', (event) => chrome.storage.sync.set({ [id]: event.target.checked }));
});
document.getElementById('teamsUrl').addEventListener('change', (event) => {
    chrome.storage.sync.set({ teamsUrl: event.target.value.trim() });
});

document.getElementById('test').addEventListener('click', async () => {
    await chrome.storage.sync.set({ teamsUrl: document.getElementById('teamsUrl').value.trim() });
    status.className = '';
    status.textContent = 'Sending…';
    const { errors } = await chrome.runtime.sendMessage({ type: 'test-alert' });
    status.className = errors.length ? 'err' : 'ok';
    status.textContent = errors.length ? errors.join('; ') : 'Sent. Check for the chime / notification.';
});

// ----- Dashboard -----
const DASH_DEFAULTS = { dashTitle: 'Service Hub', dashNames: 'full', dashPopup: true };
chrome.storage.sync.get(DASH_DEFAULTS).then((settings) => {
    document.getElementById('dashTitle').value = settings.dashTitle;
    document.getElementById('dashNames').value = settings.dashNames;
    document.getElementById('dashPopup').checked = settings.dashPopup;
});
document.getElementById('dashTitle').addEventListener('change', (event) => {
    chrome.storage.sync.set({ dashTitle: event.target.value.trim() || DASH_DEFAULTS.dashTitle });
});
document.getElementById('dashNames').addEventListener('change', (event) => chrome.storage.sync.set({ dashNames: event.target.value }));
document.getElementById('dashPopup').addEventListener('change', (event) => chrome.storage.sync.set({ dashPopup: event.target.checked }));
document.getElementById('openDashboard').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'open-dashboard' });
    window.close();
});
