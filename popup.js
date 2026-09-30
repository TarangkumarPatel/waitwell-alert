const DEFAULTS = { sound: true, teams: false, teamsUrl: '' };
const status = document.getElementById('status');

chrome.storage.sync.get(DEFAULTS).then((settings) => {
    ['sound', 'teams'].forEach((id) => { document.getElementById(id).checked = settings[id]; });
    document.getElementById('teamsUrl').value = settings.teamsUrl;
});

chrome.storage.local.get(['lastAlert', 'lastError']).then(({ lastAlert, lastError }) => {
    const parts = [];
    if (lastAlert) parts.push(`Last alert: ${lastAlert.text} (${new Date(lastAlert.at).toLocaleTimeString()})`);
    if (lastError) parts.push(`Last error: ${lastError}`);
    document.getElementById('last').textContent = parts.join(' — ');
});

['sound', 'teams'].forEach((id) => {
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
    status.textContent = errors.length ? errors.join('; ') : 'Sent. You should hear it now.';
});
