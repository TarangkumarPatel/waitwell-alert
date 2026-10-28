// Dashboard: mirrors Waitwell's waiting lists and shows who is at which table on the
// floor map. Data comes from notifier.js via background.js (chrome.storage.session,
// memory on this laptop only). Buttons here ask the Waitwell tab to click for you.
//
// Locked (default): view only. Unlocked (🔒 at the bottom left): paint tables, edit
// colours, drag/resize tables and areas. ✓ Done locks again; everything is saved.
(() => {
    const DASH_DEFAULTS = { dashTitle: 'Service Hub', dashNames: 'full', dashPopup: true, dashAlerts: true };

    // Colours: used to paint tables and to colour tickets by queue ("match" words).
    const DEFAULT_PALETTE = [
        { id: 'rep', label: 'Rep (SHR)', hex: '#fbcba9', match: ['service hub representative'] },
        { id: 'ro', label: 'RO / Registration', hex: '#b8dfe6', match: ['registration'] },
        { id: 'advising', label: 'Advising', hex: '#bdb4d5', match: ['advising'] },
        { id: 'brown', label: 'Brown', hex: '#9b5364', match: [] },
        { id: 'immigration', label: 'Immigration', hex: '#c3edbf', match: ['immigration'] },
        { id: 'career', label: 'Career Peers', hex: '#2f4f8f', match: ['career'] }
    ];
    const DEFAULT_SEATS = {
        ...Object.fromEntries(['x1', 'x2'].flatMap((t) => ['a', 'b', 'c', 'd'].map((l) => [`${t}-${l}`, 'rep']))),
        'harvest1-a': 'ro', 'harvest1-b': 'ro', 'harvest2-a': 'ro', 'harvest2-b': 'ro',
        'harvest3-a': 'advising', 'harvest3-b': 'advising'
    };
    const HOLD_GREY = '#c9c9c9';
    const DEFAULT_AREA = '#bfe4eb';
    const NO_MATCH = '#e5e5e5';
    // Chrome slows background tabs to about one check-in a minute, so only warn
    // after a long silence, and never cover the screen for it.
    const STALE_MS = 3 * 60000;
    const POPUP_MS = 8000;
    const MOVE_TIMEOUT_MS = 6000;
    const SNAP = 5;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const BASE = window.FLOOR_MAP;

    const hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session;
    const $ = (id) => document.getElementById(id);

    let settings = { ...DASH_DEFAULTS };
    let colours = freshColours();
    const freshLayout = () => ({ seats: {}, labels: {}, other: null, seatZone: {}, custom: [], deleted: {}, names: {} });
    let layout = freshLayout(); // your changes to the floor map
    let board = null;     // { at, inside, outside, desks, served, servedFound }
    let calls = [];
    let demo = null;
    let lastCallAt = Infinity;
    let unlocked = false;
    let selectedColour = null; // colour to paint with while unlocked (null = move only)
    let selectedSeat = null;   // table selected for renaming / deleting
    let dragging = null;
    const moving = new Map(); // key -> { since }

    function freshColours() {
        return { palette: DEFAULT_PALETTE.map((c) => ({ ...c, match: [...c.match] })), seats: { ...DEFAULT_SEATS }, zones: {}, areaHex: DEFAULT_AREA };
    }

    // ---------- small helpers ----------
    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const svg = (tag, attrs = {}, text) => {
        const node = document.createElementNS(SVG_NS, tag);
        Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const formatName = (raw, mode) => {
        let name = (raw || '').trim().replace(/\s+/g, ' ');
        if (name.includes(',')) {
            const [last, first] = name.split(',').map((part) => part.trim());
            name = `${first} ${last}`.trim();
        }
        const parts = name.split(' ').filter(Boolean);
        if (!parts.length) return 'Student';
        if (mode === 'full') return parts.join(' ');
        if (mode === 'first' || parts.length === 1) return parts[0];
        return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
    };
    const studentName = (raw) => formatName(raw, settings.dashNames);

    const measure = document.createElement('canvas').getContext('2d');
    const fontFamily = getComputedStyle(document.body).fontFamily;
    const textWidth = (text, size, weight = 400) => {
        measure.font = `${weight} ${size}px ${fontFamily}`;
        return measure.measureText(text).width;
    };
    const fit = (text, maxWidth, size, weight) => {
        if (textWidth(text, size, weight) <= maxWidth) return text;
        let cut = text;
        while (cut.length > 1 && textWidth(`${cut}…`, size, weight) > maxWidth) cut = cut.slice(0, -1);
        return `${cut.trimEnd()}…`;
    };
    // Split text into at most maxLines lines that each fit maxWidth (null if impossible).
    const wrapLines = (text, maxWidth, size, weight, maxLines) => {
        // Pieces: words, plus a break point after each hyphen ("Gladkikh-" | "Romanova").
        const pieces = [];
        text.split(' ').filter(Boolean).forEach((word, wi) => {
            word.split(/(?<=-)/).forEach((part, pi) => pieces.push({ part, space: wi > 0 && pi === 0 }));
        });
        const lines = [];
        let line = '';
        for (const { part, space } of pieces) {
            const next = line ? `${line}${space ? ' ' : ''}${part}` : part;
            if (textWidth(next, size, weight) <= maxWidth) { line = next; continue; }
            if (!line || textWidth(part, size, weight) > maxWidth) return null;
            lines.push(line);
            line = part;
            if (lines.length >= maxLines) return null;
        }
        if (line) lines.push(line);
        return lines.length <= maxLines ? lines : null;
    };
    // Largest size (and up to maxLines lines) at which the whole text fits; trims only as a last resort.
    const fitBlock = (text, maxWidth, sizes, weight, maxLines) => {
        // Prefer: one line, then two lines at a good size, then smaller or three lines.
        const big = sizes.filter((size) => size >= 12);
        const small = sizes.filter((size) => size < 12);
        const order = [];
        [1, 2].forEach((n) => big.forEach((size) => order.push([n, size])));
        [1, 2].forEach((n) => small.forEach((size) => order.push([n, size])));
        for (let n = 3; n <= maxLines; n += 1) sizes.forEach((size) => order.push([n, size]));
        for (const [n, size] of order) {
            if (n > maxLines) continue;
            const lines = wrapLines(text, maxWidth, size, weight, n);
            if (lines) return { lines, size };
        }
        const size = sizes[sizes.length - 1];
        return { lines: [fit(text, maxWidth, size, weight)], size };
    };
    const fitRep = (rep, maxWidth, size) => (textWidth(rep, size, 700) <= maxWidth ? rep : fit(formatName(rep, 'short'), maxWidth, size, 700));

    const hexToRgb = (hex) => {
        const m = (hex || '').replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
        return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
    };
    const parseColour = (value) => {
        if (!value) return null;
        if (value.startsWith('#')) return hexToRgb(value);
        const m = value.match(/(\d+),\s*(\d+),\s*(\d+)/);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const inkFor = (value) => {
        const rgb = parseColour(value);
        if (!rgb) return '#111';
        const [r, g, b] = rgb.map((c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111' : '#fff';
    };
    const colourById = (id) => colours.palette.find((c) => c.id === id);
    const darker = (hex, amount = 0.25) => {
        const rgb = hexToRgb(hex) || [143, 195, 204];
        return `#${rgb.map((c) => Math.round(c * (1 - amount)).toString(16).padStart(2, '0')).join('')}`;
    };
    const areaFill = (key) => { const c = colourById((colours.zones || {})[key]); return c ? c.hex : (colours.areaHex || DEFAULT_AREA); };

    // Brush cursor in the selected colour, so it's obvious painting is on.
    const paintCursor = (hex) => {
        const fill = hex || '#ffffff';
        const slash = hex ? '' : '<line x1="17" y1="27" x2="29" y2="15" stroke="#d00" stroke-width="2.5"/>';
        const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M2 2 L2 17 L6 13 L9 20 L12 19 L9 12 L15 12 Z" fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/><circle cx="23" cy="21" r="8" fill="${fill}" stroke="#000" stroke-width="2"/>${slash}</svg>`;
        return `url("data:image/svg+xml,${encodeURIComponent(svgText)}") 2 2, pointer`;
    };

    // Ticket colour: grey when on hold, else the colour whose queue words match.
    const ticketColour = (ticket) => {
        if (ticket.hold) return HOLD_GREY;
        for (const text of [ticket.queue, ticket.category]) {
            const t = (text || '').toLowerCase();
            if (!t) continue;
            const hit = colours.palette.find((c) => (c.match || []).some((w) => w && t.includes(w.toLowerCase())));
            if (hit) return hit.hex;
        }
        return NO_MATCH;
    };

    let toastTimer = null;
    const toast = (message, ok) => {
        const node = $('toast');
        node.textContent = message;
        node.className = `toast${ok ? ' ok' : ''}`;
        node.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { node.hidden = true; }, 4500);
    };

    const save = (key, value) => { if (!demo && hasChrome) chrome.storage.sync.set({ [key]: value }); };
    const saveColours = () => save('dashColours', colours);
    const saveLayout = () => save('dashLayout', layout);

    // ---------- commands to Waitwell ----------
    const command = async (cmd) => {
        if (demo) return demo.command(cmd);
        if (!hasChrome) return { ok: false, error: 'Not running inside the extension' };
        try {
            return await chrome.runtime.sendMessage({ type: 'dash-command', command: cmd });
        } catch (error) {
            return { ok: false, error: 'Extension not reachable' };
        }
    };

    const startMove = async (key, button) => {
        if (moving.has(key)) return;
        moving.set(key, { since: Date.now() });
        if (button) { button.classList.add('busy'); button.disabled = true; }
        const result = await command({ type: 'move-inside', key });
        if (!result || !result.ok) {
            moving.delete(key);
            toast(`Couldn't move: ${(result && result.error) || 'unknown problem'}. Please use Waitwell.`);
            lastListsJson = '';
            renderLists();
        }
    };

    const checkMoves = () => {
        const outsideKeys = new Set((board && board.outside.tickets || []).map((ticket) => ticket.key));
        moving.forEach((info, key) => {
            if (!outsideKeys.has(key)) moving.delete(key);
            else if (Date.now() - info.since > MOVE_TIMEOUT_MS) {
                moving.delete(key);
                toast("That ticket didn't move. Please move it in Waitwell.");
            }
        });
    };

    // ---------- waiting lists ----------
    const ticketCard = (ticket, where) => {
        const card = el('article', `ticket${ticket.hold ? ' hold' : ''}`);
        const bg = ticketColour(ticket);
        card.style.setProperty('--tbg', bg);
        card.style.setProperty('--tfg', inkFor(bg));
        const main = el('div', 't-main');
        main.append(el('div', 't-name', studentName(ticket.name)));
        const meta = [ticket.category, ticket.queue].filter(Boolean).join(' · ');
        if (meta) main.append(el('div', 't-meta', meta));
        if (ticket.tags && ticket.tags.length) {
            const tags = el('div', 't-tags');
            ticket.tags.forEach((tag) => tags.append(el('span', '', tag)));
            main.append(tags);
        }
        const side = el('div', 't-side');
        if (ticket.hold) side.append(el('div', 't-hold', 'On hold'));
        if (ticket.wait) side.append(el('div', 't-wait', ticket.wait));
        if (where === 'outside') {
            const move = el('button', 't-move', '↑');
            move.type = 'button';
            move.title = 'Move inside';
            move.setAttribute('aria-label', `Move ${studentName(ticket.name)} inside`);
            if (moving.has(ticket.key)) { move.classList.add('busy'); move.disabled = true; }
            move.addEventListener('click', () => startMove(ticket.key, move));
            side.append(move);
        }
        card.append(main, side);
        return card;
    };

    let lastListsJson = '';
    const renderLists = () => {
        const inside = board ? board.inside : { label: 'Waiting Inside', tickets: [] };
        const outside = board ? board.outside : { label: 'Waiting Outside', tickets: [] };
        $('insideLabel').textContent = inside.label;
        $('outsideLabel').textContent = outside.label;
        $('moveNext').disabled = !outside.tickets.length;
        const json = JSON.stringify([inside.tickets, outside.tickets, settings.dashNames, [...moving.keys()], colours.palette]);
        if (json === lastListsJson) return;
        lastListsJson = json;
        [['insideList', inside.tickets, 'inside'], ['outsideList', outside.tickets, 'outside']].forEach(([id, tickets, where]) => {
            const list = $(id);
            const scroll = list.scrollTop;
            list.innerHTML = '';
            if (!tickets.length) list.append(el('p', 'empty-list', where === 'inside' ? 'No one waiting inside.' : 'No one waiting outside.'));
            tickets.forEach((ticket) => list.append(ticketCard(ticket, where)));
            list.scrollTop = scroll;
        });
    };

    // ---------- resizable split between Inside and Outside ----------
    const queues = $('queues');
    const applySplit = (pct) => queues.style.setProperty('--split', `${Math.min(85, Math.max(15, pct))}%`);
    try { const saved = Number(localStorage.getItem('dashSplit')); if (saved) applySplit(saved); } catch (error) { /* ignore */ }
    const splitter = $('splitter');
    const splitTo = (clientY) => {
        const box = queues.getBoundingClientRect();
        const pct = ((clientY - box.top) / box.height) * 100;
        applySplit(pct);
        try { localStorage.setItem('dashSplit', String(Math.min(85, Math.max(15, pct)))); } catch (error) { /* ignore */ }
    };
    splitter.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        splitter.classList.add('dragging');
        const onMove = (e) => splitTo(e.clientY);
        const onUp = () => {
            splitter.classList.remove('dragging');
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    });
    splitter.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        const current = parseFloat(getComputedStyle(queues).getPropertyValue('--split')) || 58;
        const pct = current + (event.key === 'ArrowUp' ? -3 : 3);
        applySplit(pct);
        try { localStorage.setItem('dashSplit', String(pct)); } catch (error) { /* ignore */ }
    });

    // ---------- map geometry (base layout + your changes) ----------
    // Areas (blue backgrounds) are not stored: each one is drawn around the tables
    // that belong to it, so it grows and shrinks as tables move in and out.
    const inRect = (pt, r) => pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h;
    const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    const baseZoneOf = (r) => { const i = BASE.zones.findIndex((z) => inRect(centre(r), z)); return i < 0 ? '' : `z${i}`; };
    const BASE_SEAT_ZONE = Object.fromEntries(BASE.seats.map((seat) => [seat.id, baseZoneOf(seat)]));
    const BASE_LABEL_ZONE = (BASE.groupLabels || []).map((l) => baseZoneOf({ x: l.x, y: l.y - 8, w: 1, h: 1 }));
    const ZONE_PAD = 12;
    const ZONE_TOP = 28;
    const norm = (t) => (t || '').toLowerCase().replace(/[–—]/g, '-').replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim();

    const seatsNow = () => [
        ...BASE.seats.filter((seat) => !layout.deleted[seat.id]).map((seat) => ({
            ...seat, ...(layout.seats[seat.id] || {}), ...(layout.names[seat.id] || {}),
            key: seat.id, zone: layout.seatZone[seat.id] ?? BASE_SEAT_ZONE[seat.id]
        })),
        ...layout.custom.map((c) => ({ ...c, ...(layout.seats[c.id] || {}), key: c.id, zone: layout.seatZone[c.id] ?? '' }))
    ];
    const labelsNow = () => (BASE.groupLabels || []).map((label, i) => ({ ...label, ...(layout.labels[`l${i}`] || {}), key: `l${i}`, zone: BASE_LABEL_ZONE[i] }));
    const otherNow = () => ({ ...BASE.other, ...(layout.other || {}) });
    const zonesNow = (seats = seatsNow(), skipKey = null) => BASE.zones.map((zone, i) => {
        const key = `z${i}`;
        const members = seats.filter((seat) => seat.zone === key && seat.key !== skipKey);
        if (!members.length) return null;
        const labels = labelsNow().filter((l) => l.zone === key);
        let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
        members.forEach((m) => { x1 = Math.min(x1, m.x); y1 = Math.min(y1, m.y); x2 = Math.max(x2, m.x + m.w); y2 = Math.max(y2, m.y + m.h); });
        labels.forEach((l) => { x1 = Math.min(x1, l.x); x2 = Math.max(x2, l.x + textWidth(l.text, 15, 700)); y1 = Math.min(y1, l.y - 16); y2 = Math.max(y2, l.y + 4); });
        return { label: zone.label, key, x: x1 - ZONE_PAD, y: y1 - ZONE_TOP, w: x2 - x1 + ZONE_PAD * 2, h: y2 - y1 + ZONE_TOP + ZONE_PAD, members, labels };
    }).filter(Boolean);

    // Which area a table belongs to after you drop it.
    const zoneForDrop = (seat) => {
        const others = zonesNow(seatsNow(), seat.key);
        const c = centre(seat);
        const near = others.find((z) => inRect(c, { x: z.x - 24, y: z.y - 24, w: z.w + 48, h: z.h + 48 }));
        if (near) return near.key;
        let best = null; let bestArea = 0;
        others.forEach((z) => {
            const w = Math.min(seat.x + seat.w, z.x + z.w) - Math.max(seat.x, z.x);
            const h = Math.min(seat.y + seat.h, z.y + z.h) - Math.max(seat.y, z.y);
            if (w > 0 && h > 0 && w * h > bestArea) { best = z.key; bestArea = w * h; }
        });
        if (best) return best;
        // Dropped in open space: a table that was alone in its area takes the area with it.
        const stillThere = others.some((z) => z.key === seat.zone);
        return seat.zone && !stillThere ? seat.zone : '';
    };

    // Waitwell table name -> table on the map ('' = goes to Other desks).
    const resolveSeat = (table) => {
        const seats = seatsNow();
        const n = norm(table);
        const named = seats.find((seat) => seat.name && norm(seat.name) === n);
        if (named) return named.key;
        const keys = new Set(seats.map((seat) => seat.key));
        const id = window.seatIdFor(table);
        if (!id) return '';
        if (keys.has(id)) return id;
        if (keys.has(id.replace(/-[a-d]$/, ''))) return id.replace(/-[a-d]$/, '');
        if (keys.has(`${id}-a`)) return `${id}-a`;
        return '';
    };

    // ---------- floor map ----------
    const mapSvg = $('map');
    mapSvg.setAttribute('viewBox', `0 0 ${BASE.width} ${BASE.height}`);
    mapSvg.setAttribute('preserveAspectRatio', 'xMidYMin meet');

    const toMap = (event) => {
        const pt = mapSvg.createSVGPoint();
        pt.x = event.clientX; pt.y = event.clientY;
        return pt.matrixTransform(mapSvg.getScreenCTM().inverse());
    };
    const snap = (v) => Math.round(v / SNAP) * SNAP;
    const geomOf = (r) => ({ x: r.x, y: r.y, w: r.w, h: r.h });

    // Drag something on the map while unlocked. kind: seat | zone | label | other.
    const startDrag = (event, kind, target, mode, onClick) => {
        if (!unlocked || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const start = toMap(event);
        const startGeom = geomOf(target);
        const members = kind === 'zone' ? target.members.map((m) => ({ key: m.key, g: geomOf(m) })) : [];
        const memberLabels = kind === 'zone' ? target.labels.map((l) => ({ key: l.key, x: l.x, y: l.y })) : [];
        let moved = false;
        dragging = { kind, key: target.key };
        document.body.classList.add('dragging-map');
        const onMove = (e) => {
            const p = toMap(e);
            const dx = p.x - start.x;
            const dy = p.y - start.y;
            if (!moved && Math.hypot(dx, dy) < 4) return;
            moved = true;
            if (kind === 'seat') {
                layout.seats[target.key] = mode === 'resize'
                    ? { ...startGeom, w: Math.max(40, snap(startGeom.w + dx)), h: Math.max(30, snap(startGeom.h + dy)) }
                    : { ...startGeom, x: snap(startGeom.x + dx), y: snap(startGeom.y + dy) };
            } else if (kind === 'zone') {
                members.forEach((m) => { layout.seats[m.key] = { ...m.g, x: snap(m.g.x + dx), y: snap(m.g.y + dy) }; });
                memberLabels.forEach((l) => { layout.labels[l.key] = { x: snap(l.x + dx), y: snap(l.y + dy) }; });
            } else if (kind === 'label') {
                layout.labels[target.key] = { x: snap(startGeom.x + dx), y: snap(startGeom.y + dy) };
            } else if (kind === 'other') {
                layout.other = mode === 'resize'
                    ? { ...startGeom, w: Math.max(150, snap(startGeom.w + dx)), h: Math.max(80, snap(startGeom.h + dy)) }
                    : { ...startGeom, x: snap(startGeom.x + dx), y: snap(startGeom.y + dy) };
            }
            drawMap();
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            document.body.classList.remove('dragging-map');
            dragging = null;
            if (moved && kind === 'seat' && mode === 'move') {
                const seat = seatsNow().find((t) => t.key === target.key);
                if (seat) layout.seatZone[seat.key] = zoneForDrop(seat);
            }
            if (moved) saveLayout();
            else if (onClick) onClick();
            drawMap();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };

    const addHandle = (g, target, kind) => {
        if (!unlocked) return;
        const handle = svg('rect', { class: 'handle', x: target.x + target.w - 10, y: target.y + target.h - 10, width: 10, height: 10 });
        handle.addEventListener('pointerdown', (e) => startDrag(e, kind, target, 'resize'));
        g.append(handle);
    };

    const drawSeat = (parent, seat, desk, ticket, dragKind) => {
        const g = svg('g', { class: 'seat' });
        if (desk) g.classList.add('has-rep');
        const colour = colourById(colours.seats[seat.key]);
        const fill = colour ? colour.hex : '#eeeeee';
        const ink = inkFor(fill);
        const onClick = () => {
            if (selectedColour) {
                if (selectedColour === 'none') delete colours.seats[seat.key]; else colours.seats[seat.key] = selectedColour;
                saveColours();
                renderLegend();
            } else if (dragKind) {
                selectedSeat = selectedSeat === seat.key ? null : seat.key;
                renderAdmin();
            } else if (seat.otherTable) {
                addTable(seat.otherTable);
                return;
            }
            drawMap();
        };
        if (unlocked) {
            if (selectedSeat === seat.key) g.classList.add('selected');
            if (dragKind) g.addEventListener('pointerdown', (e) => startDrag(e, dragKind, seat, 'move', onClick));
            else g.addEventListener('pointerdown', (e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } });
            if (!dragKind && seat.otherTable) g.append(svg('title', {}, 'Click to add this desk as a table on the map'));
        } else if (ticket && ticket.glowing) {
            g.classList.add('glowing');
            g.append(svg('title', {}, 'Click to clear the glow'));
            g.addEventListener('click', () => clearGlow(ticket.key));
        }
        const { x, y, w, h } = seat;
        g.append(svg('rect', { class: 'seat-box', x, y, width: w, height: h, fill }));
        const pad = 8;
        const compact = h < 66;
        const repText = desk ? desk.rep : '';
        const inner = w - pad * 2;
        const student = ticket ? studentName(ticket.name) + (ticket.extra ? ` +${ticket.extra}` : '') : '';
        let pill = null;
        if (compact) {
            // One line for "label · rep", one line for the student.
            const label = `${seat.label}${repText ? ' · ' : ''}`;
            const labelWidth = textWidth(label, 11, 700);
            g.append(svg('text', { class: 'seat-label', x: x + pad, y: y + 17, fill: ink }, fit(label, inner, 11, 700)));
            if (repText && labelWidth < inner - 20) {
                const rep = fitBlock(repText, inner - labelWidth, [12, 11, 10], 700, 1);
                g.append(svg('text', { class: 'seat-rep', x: x + pad + labelWidth, y: y + 17, 'font-size': rep.size, fill: ink }, rep.lines[0]));
            }
            if (ticket) pill = { ...fitBlock(student, w - 24, [13, 12, 11, 10], 700, 1) };
        } else {
            g.append(svg('text', { class: 'seat-label', x: x + pad, y: y + 16, fill: ink }, fit(seat.label, inner, 11, 700)));
            // Student first: it gets up to 2 lines; the rep uses whatever room is left above.
            if (ticket) pill = fitBlock(student, w - 24, [13, 12, 11, 10], 700, h >= 90 ? 3 : 2);
            const pillH = pill ? pill.lines.length * (pill.size + 3) + 8 : 0;
            const roomForRep = h - 22 - (pill ? pillH + 8 : 4);
            if (repText) {
                const maxLines = Math.max(1, Math.min(2, Math.floor(roomForRep / 17)));
                const rep = fitBlock(repText, inner, [14, 13, 12, 11, 10], 700, maxLines);
                rep.lines.forEach((line, i) => g.append(svg('text', { class: 'seat-rep', x: x + pad, y: y + 35 + i * (rep.size + 3), 'font-size': rep.size, fill: ink }, line)));
            } else {
                g.append(svg('text', { class: 'seat-norep', x: x + pad, y: y + 35, fill: ink }, 'No rep'));
            }
        }
        if (ticket && pill) {
            const lineH = pill.size + 3;
            const pillH = pill.lines.length * lineH + 8;
            const py = y + h - pillH - 6;
            const pillFill = ticketColour(ticket);
            g.append(svg('rect', { class: 'pill', x: x + 6, y: py, width: Math.max(10, w - 12), height: pillH, fill: pillFill }));
            pill.lines.forEach((line, i) => g.append(svg('text', {
                class: 'pill-text', x: x + 12, y: py + 4 + pill.size + i * lineH, 'font-size': pill.size, fill: inkFor(pillFill)
            }, line)));
        }
        if (dragKind) addHandle(g, seat, dragKind);
        parent.append(g);
    };

    const drawMap = () => {
        mapSvg.innerHTML = '';
        mapSvg.classList.toggle('editing', unlocked);
        const painting = unlocked && !!selectedColour;
        mapSvg.classList.toggle('painting', painting);
        if (painting) mapSvg.style.setProperty('--paint-cursor', paintCursor(selectedColour === 'none' ? '' : (colourById(selectedColour) || {}).hex));
        if (BASE.wall) mapSvg.append(svg('rect', { class: 'wall', x: BASE.wall.x, y: BASE.wall.y, width: BASE.wall.w, height: BASE.wall.h }));

        const seats = seatsNow();
        zonesNow(seats).forEach((zone) => {
            const g = svg('g', { class: 'zone' });
            const zoneFill = areaFill(zone.key);
            g.append(svg('rect', { x: zone.x, y: zone.y, width: zone.w, height: zone.h, style: `fill:${zoneFill};stroke:${darker(zoneFill)}` }));
            g.append(svg('text', { x: zone.x + zone.w / 2, y: zone.y + 18, 'text-anchor': 'middle', style: `fill:${inkFor(zoneFill)}` }, fit(zone.label, zone.w - 10, 14, 700)));
            if (unlocked) {
                g.append(svg('title', {}, 'Drag to move this whole area'));
                g.addEventListener('pointerdown', (e) => startDrag(e, 'zone', zone, 'move', () => {
                    if (!selectedColour) return;
                    colours.zones = colours.zones || {};
                    if (selectedColour === 'none') delete colours.zones[zone.key]; else colours.zones[zone.key] = selectedColour;
                    saveColours();
                }));
            }
            mapSvg.append(g);
        });
        labelsNow().forEach((label) => {
            const t = svg('text', { class: 'group-label', x: label.x, y: label.y }, label.text);
            if (unlocked) t.addEventListener('pointerdown', (e) => startDrag(e, 'label', { ...label, w: 0, h: 0 }, 'move'));
            mapSvg.append(t);
        });

        const desks = board ? board.desks : [];
        const served = board ? board.served : [];
        const deskBySeat = new Map();
        const ticketBySeat = new Map();
        const otherDesks = new Map();
        const addTicket = (map, key, ticket) => {
            const existing = map.get(key);
            if (!existing) map.set(key, { ...ticket, extra: 0 });
            else map.set(key, ticket.glowing && !existing.glowing ? { ...ticket, extra: existing.extra + 1 } : { ...existing, extra: existing.extra + 1 });
        };
        desks.forEach((desk) => {
            const seatId = resolveSeat(desk.table);
            if (seatId) deskBySeat.set(seatId, desk);
            else otherDesks.set(desk.table, { desk, ticket: null });
        });
        served.forEach((ticket) => {
            const seatId = resolveSeat(ticket.table);
            if (seatId) { addTicket(ticketBySeat, seatId, ticket); return; }
            const entry = otherDesks.get(ticket.table) || { desk: { table: ticket.table, rep: ticket.rep }, ticket: null };
            const tmp = new Map(entry.ticket ? [['t', entry.ticket]] : []);
            addTicket(tmp, 't', ticket);
            entry.ticket = tmp.get('t');
            otherDesks.set(ticket.table, entry);
        });


        // Other desks box
        const box = otherNow();
        const g = svg('g', { class: 'other-box' });
        g.append(svg('rect', { class: 'frame', x: box.x, y: box.y, width: box.w, height: box.h }));
        g.append(svg('text', { class: 'title', x: box.x + 10, y: box.y + 20 }, 'Other desks'));
        if (unlocked) g.addEventListener('pointerdown', (e) => startDrag(e, 'other', { ...box, key: 'other' }, 'move'));
        const entries = [...otherDesks.values()].sort((a, b) => (b.ticket ? 1 : 0) - (a.ticket ? 1 : 0));
        if (!entries.length) g.append(svg('text', { class: 'none', x: box.x + 10, y: box.y + 42 }, 'None right now'));
        const cols = box.w > 300 ? 2 : 1;
        const entryW = (box.w - 16 - (cols - 1) * 8) / cols;
        const rows = Math.max(1, Math.floor((box.h - 36) / 62));
        const room = cols * rows;
        const shown = entries.length > room ? entries.slice(0, room - 1) : entries;
        shown.forEach((entry, i) => {
            drawSeat(g, {
                label: entry.desk.table, key: `desk:${entry.desk.table}`, otherTable: entry.desk.table,
                x: box.x + 8 + (i % cols) * (entryW + 8), y: box.y + 32 + Math.floor(i / cols) * 62, w: entryW, h: 56
            }, entry.desk, entry.ticket, null);
        });
        if (entries.length > room) g.append(svg('text', { class: 'none', x: box.x + box.w - 12, y: box.y + box.h - 12, 'text-anchor': 'end' }, `+ ${entries.length - shown.length} more`));
        addHandle(g, { ...box, key: 'other' }, 'other');
        mapSvg.append(g);

        // Tables last, so a table moved over the Other desks box stays visible.
        seats.forEach((seat) => drawSeat(mapSvg, seat, deskBySeat.get(seat.key), ticketBySeat.get(seat.key), 'seat'));
    };

    const clearGlow = async (key) => {
        if (board) board.served = board.served.map((ticket) => (ticket.key === key ? { ...ticket, glowing: false } : ticket));
        drawMap();
        const result = await command({ type: 'clear-glow', key });
        if (!result || !result.ok) toast("Couldn't clear the glow in Waitwell. Refresh Waitwell and try again.");
    };

    // ---------- legend ----------
    const renderLegend = () => {
        const legend = $('legend');
        legend.innerHTML = '';
        const glow = el('span', 'chip');
        const glowIcon = el('i');
        glowIcon.style.cssText = 'background:#fff;border:3px solid #22c55e';
        glow.append(glowIcon, document.createTextNode('New: click to clear'));
        legend.append(glow);
        const used = new Set(Object.values(colours.seats));
        colours.palette.filter((c) => used.has(c.id)).forEach((c) => {
            const chip = el('span', 'chip');
            const sw = el('i');
            sw.style.background = c.hex;
            chip.append(sw, document.createTextNode(c.label));
            legend.append(chip);
        });
    };

    // ---------- lock / edit bar ----------
    const renderAdmin = () => {
        $('adminBar').hidden = !unlocked;
        const lock = $('lockBtn');
        lock.textContent = unlocked ? '🔓' : '🔒';
        lock.classList.toggle('open', unlocked);
        lock.title = unlocked ? 'Lock (same as ✓ Done)' : 'Unlock to edit colours and layout';
        lock.setAttribute('aria-label', lock.title);
        if (!unlocked) return;

        const swatches = $('swatches');
        swatches.innerHTML = '';
        const make = (id, label, hex) => {
            const b = el('button', `swatch${selectedColour === id ? ' selected' : ''}${id === 'none' ? ' none' : ''}`);
            b.type = 'button';
            const i = el('i');
            if (hex) i.style.background = hex;
            b.append(i, document.createTextNode(label));
            b.addEventListener('click', () => { selectedColour = selectedColour === id ? null : id; if (selectedColour) selectedSeat = null; renderAdmin(); drawMap(); });
            swatches.append(b);
        };
        colours.palette.forEach((c) => make(c.id, c.label, c.hex));
        make('none', 'No colour', '');

        $('areaPicker').value = colours.areaHex || DEFAULT_AREA;
        const table = selectedTable();
        $('tableRow').hidden = !table;
        if (table) {
            if (document.activeElement !== $('tableLabel')) $('tableLabel').value = table.label || '';
            if (document.activeElement !== $('tableName')) $('tableName').value = table.name || '';
            $('tableName').placeholder = layout.custom.some((c) => c.id === table.key)
                ? 'Name in Waitwell, e.g. Short Table 5' : 'Matched automatically (type to override)';
        }

        const editing = colourById(selectedColour);
        $('editRow').hidden = !editing;
        if (editing) {
            $('editPicker').value = editing.hex;
            if (document.activeElement !== $('editHex')) $('editHex').value = editing.hex;
            if (document.activeElement !== $('editLabel')) $('editLabel').value = editing.label;
            if (document.activeElement !== $('editMatch')) $('editMatch').value = (editing.match || []).join(', ');
        }
    };

    const setLocked = (locked) => {
        unlocked = !locked;
        if (locked) { selectedColour = null; selectedSeat = null; saveColours(); saveLayout(); }
        renderAdmin();
        drawMap();
    };
    $('lockBtn').addEventListener('click', () => setLocked(unlocked));
    $('doneBtn').addEventListener('click', () => { setLocked(true); toast('Changes saved and locked.', true); });

    const editingColour = () => colourById(selectedColour);
    const afterColourEdit = () => { saveColours(); lastListsJson = ''; renderLists(); drawMap(); renderLegend(); renderAdmin(); };
    $('editPicker').addEventListener('input', () => { const c = editingColour(); if (!c) return; c.hex = $('editPicker').value; $('editHex').value = c.hex; afterColourEdit(); });
    $('editHex').addEventListener('change', () => {
        const c = editingColour(); if (!c) return;
        let hex = $('editHex').value.trim(); if (!hex.startsWith('#')) hex = `#${hex}`;
        if (hexToRgb(hex)) { c.hex = hex.toLowerCase(); afterColourEdit(); } else toast('Enter a colour like #3b82f6');
    });
    $('editLabel').addEventListener('change', () => { const c = editingColour(); if (!c) return; c.label = $('editLabel').value.trim() || c.label; afterColourEdit(); });
    $('editMatch').addEventListener('change', () => {
        const c = editingColour(); if (!c) return;
        c.match = $('editMatch').value.split(',').map((w) => w.trim()).filter(Boolean);
        afterColourEdit();
    });
    $('deleteColour').addEventListener('click', () => {
        const c = editingColour(); if (!c) return;
        colours.palette = colours.palette.filter((p) => p.id !== c.id);
        Object.keys(colours.seats).forEach((k) => { if (colours.seats[k] === c.id) delete colours.seats[k]; });
        selectedColour = null;
        afterColourEdit();
    });
    $('addColour').addEventListener('click', () => {
        const id = `c${Date.now()}`;
        colours.palette.push({ id, label: 'New colour', hex: '#3b82f6', match: [] });
        selectedColour = id;
        afterColourEdit();
        $('editLabel').focus();
        $('editLabel').select();
    });
    $('resetColours').addEventListener('click', () => { colours = freshColours(); selectedColour = null; afterColourEdit(); });
    $('resetLayout').addEventListener('click', () => {
        if (!window.confirm('Put every table back where it started? Tables you added will be removed and deleted tables come back.')) return;
        layout = freshLayout();
        selectedSeat = null;
        saveLayout();
        renderAdmin();
        drawMap();
    });

    // ---------- add / rename / delete tables ----------
    const selectedTable = () => seatsNow().find((seat) => seat.key === selectedSeat);
    const addTable = (waitwellName) => {
        const box = otherNow();
        const id = `t${Date.now()}`;
        const offset = (layout.custom.length % 5) * 14;
        layout.custom.push({ id, label: waitwellName || 'New table', name: waitwellName || '', x: snap(box.x + 12 + offset), y: snap(box.y + 30 + offset), w: 130, h: 80 });
        selectedSeat = id;
        selectedColour = null;
        saveLayout();
        renderAdmin();
        drawMap();
        if (!waitwellName) { $('tableName').focus(); }
        toast(waitwellName ? `Added ${waitwellName}. Drag it into place.` : 'Table added. Type its Waitwell name, then drag it into place.', true);
    };
    $('addTable').addEventListener('click', () => addTable(''));
    $('areaPicker').addEventListener('input', () => { colours.areaHex = $('areaPicker').value; drawMap(); });
    $('areaPicker').addEventListener('change', saveColours);
    const updateTable = (field, value) => {
        const seat = selectedTable(); if (!seat) return;
        const custom = layout.custom.find((c) => c.id === seat.key);
        if (custom) custom[field] = value;
        else layout.names[seat.key] = { ...(layout.names[seat.key] || {}), [field]: value };
        saveLayout();
        drawMap();
    };
    $('tableLabel').addEventListener('change', () => updateTable('label', $('tableLabel').value.trim() || 'Table'));
    $('tableName').addEventListener('change', () => {
        const name = $('tableName').value.trim();
        updateTable('name', name);
        const seat = selectedTable();
        if (seat && name && (!seat.label || seat.label === 'New table')) { updateTable('label', name); $('tableLabel').value = name; }
    });
    $('deleteTable').addEventListener('click', () => {
        const seat = selectedTable(); if (!seat) return;
        if (layout.custom.some((c) => c.id === seat.key)) layout.custom = layout.custom.filter((c) => c.id !== seat.key);
        else layout.deleted[seat.key] = true;
        delete layout.seats[seat.key];
        delete layout.seatZone[seat.key];
        delete colours.seats[seat.key];
        selectedSeat = null;
        saveLayout();
        saveColours();
        renderAdmin();
        drawMap();
        renderLegend();
        toast('Table deleted. Reset layout brings back the original tables.', true);
    });

    // ---------- header toggles ----------
    const renderToggles = () => {
        const set = (id, on, label) => {
            const b = $(id);
            b.setAttribute('aria-pressed', String(!!on));
            b.innerHTML = `${label}: <strong>${on ? 'On' : 'Off'}</strong>`;
        };
        set('popupToggle', settings.dashPopup, '“It\'s your turn” pop-up');
        set('alertsToggle', settings.dashAlerts, 'Recent alerts');
    };
    $('popupToggle').addEventListener('click', () => {
        settings.dashPopup = !settings.dashPopup;
        if (!settings.dashPopup) { pendingCalls.length = 0; if (!$('call').hidden) hideCall(); }
        save('dashPopup', settings.dashPopup);
        renderToggles();
    });
    $('alertsToggle').addEventListener('click', () => {
        settings.dashAlerts = !settings.dashAlerts;
        save('dashAlerts', settings.dashAlerts);
        renderToggles();
        renderAlerts();
    });

    // ---------- recent alerts (same text as the desktop notification) ----------
    const renderAlerts = () => {
        $('alerts').hidden = !settings.dashAlerts;
        if (!settings.dashAlerts) return;
        const list = $('alertsList');
        list.innerHTML = '';
        const recent = calls.slice(-3).reverse();
        if (!recent.length) { list.append(el('li', 'none', 'No alerts yet.')); return; }
        recent.forEach((call) => {
            const li = el('li');
            const time = el('time', '', new Date(call.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
            li.append(time, el('span', '', `${studentName(call.name)} to ${call.rep || 'the rep'} at ${call.table}`));
            list.append(li);
        });
    };

    // ---------- header / status ----------
    const renderHeader = () => {
        const now = new Date();
        $('time').textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        $('date').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
        $('title').textContent = settings.dashTitle;
        document.title = `${settings.dashTitle} · Dashboard`;
        // The cover screen only shows when there is no Waitwell data at all
        // (never opened, or the Waitwell tab was closed).
        const connected = !!(demo || board);
        const quietMs = board ? Date.now() - board.at : 0;
        const stale = !demo && board && quietMs > STALE_MS;
        $('statusDot').classList.toggle('live', connected && !stale);
        $('statusDot').classList.toggle('stale', !!stale);
        $('statusText').textContent = demo ? 'Sample data (not live)'
            : !board ? 'Waiting for Waitwell…'
                : stale ? `No update from Waitwell for ${Math.round(quietMs / 60000)} min. Check the Waitwell tab is still open.`
                    : board.servedFound ? 'Live from Waitwell' : 'Live from Waitwell · Being Served not visible';
        $('offline').hidden = connected;
    };

    const render = () => {
        checkMoves();
        renderHeader();
        renderToggles();
        renderLegend();
        renderLists();
        renderAlerts();
        if (!dragging) drawMap();
    };

    // ---------- "It's your turn" pop-up ----------
    const pendingCalls = [];
    let showing = false;
    let hideTimer = null;
    const hideCall = () => {
        clearTimeout(hideTimer);
        $('call').hidden = true;
        showing = false;
        setTimeout(showNextCall, 300);
    };
    const showNextCall = () => {
        if (showing || !pendingCalls.length || !settings.dashPopup) return;
        showing = true;
        const call = pendingCalls.shift();
        $('callName').textContent = studentName(call.name);
        $('callTable').textContent = call.table;
        const bar = $('callBar');
        bar.style.transition = 'none';
        bar.style.transform = 'scaleX(1)';
        $('call').hidden = false;
        const duration = pendingCalls.length ? 5000 : POPUP_MS;
        requestAnimationFrame(() => requestAnimationFrame(() => {
            bar.style.transition = `transform ${duration}ms linear`;
            bar.style.transform = 'scaleX(0)';
        }));
        hideTimer = setTimeout(hideCall, duration);
    };
    $('call').addEventListener('click', hideCall);

    const checkNewCalls = () => {
        const fresh = calls.filter((call) => call.at > lastCallAt);
        if (calls.length) lastCallAt = Math.max(...calls.map((call) => call.at));
        if (settings.dashPopup) pendingCalls.push(...fresh);
        showNextCall();
    };

    // ---------- buttons ----------
    $('moveNext').addEventListener('click', async () => {
        const button = $('moveNext');
        button.disabled = true;
        const first = board && board.outside.tickets[0];
        const result = await command({ type: 'move-next-inside' });
        if (!result || !result.ok) {
            toast(`Couldn't move: ${(result && result.error) || 'unknown problem'}. Please use Waitwell.`);
            button.disabled = false;
        } else if (first) {
            moving.set(first.key, { since: Date.now() });
        }
    });

    // ---------- data ----------
    const load = async () => {
        settings = { ...DASH_DEFAULTS, ...(await chrome.storage.sync.get(DASH_DEFAULTS)) };
        const stored = await chrome.storage.sync.get(['dashColours', 'dashLayout']);
        if (stored.dashColours && Array.isArray(stored.dashColours.palette)) {
            colours = { palette: stored.dashColours.palette, seats: stored.dashColours.seats || {}, zones: stored.dashColours.zones || {}, areaHex: stored.dashColours.areaHex || DEFAULT_AREA };
            // Older saves had no queue words on built-in colours; fill them in.
            colours.palette.forEach((c) => {
                const builtin = DEFAULT_PALETTE.find((d) => d.id === c.id);
                if (!Array.isArray(c.match)) c.match = builtin ? [...builtin.match] : [];
            });
        }
        if (stored.dashLayout) layout = { ...freshLayout(), ...stored.dashLayout };
        const data = await chrome.storage.session.get(['board', 'calls']);
        board = data.board || null;
        calls = data.calls || [];
        lastCallAt = calls.length ? Math.max(...calls.map((call) => call.at)) : 0;
        render();
        chrome.storage.onChanged.addListener((changes, area) => {
            if (demo) return;
            if (area === 'session') {
                if (changes.board) board = changes.board.newValue || null;
                if (changes.calls) { calls = changes.calls.newValue || []; checkNewCalls(); }
            } else if (area === 'sync') {
                if (!unlocked && changes.dashColours && changes.dashColours.newValue) colours = { zones: {}, areaHex: DEFAULT_AREA, ...changes.dashColours.newValue };
                if (!unlocked && changes.dashLayout && changes.dashLayout.newValue) layout = { ...freshLayout(), ...changes.dashLayout.newValue };
                Object.keys(DASH_DEFAULTS).forEach((key) => {
                    if (changes[key]) settings[key] = changes[key].newValue ?? DASH_DEFAULTS[key];
                });
                lastListsJson = '';
            }
            render();
        });
    };

    // ---------- sample data ----------
    const startDemo = () => {
        let n = 0;
        const t = (name, category, queue, tags, wait, extra = {}) => {
            n += 1;
            return { key: `demo:${n}`, name, category, queue, tags, wait, ...extra };
        };
        const state = {
            at: Date.now(),
            inside: { label: 'Waiting Inside (3/20)', tickets: [
                t('Amara Okafor', 'Registration', 'Registration Office', ['Part-Time', 'Domestic'], '7min'),
                t('Franck Ngonga', 'Drop-In', 'Immigration', ['International'], '44min'),
                t('Liam Chen', 'Student Advising', 'Service Hub Representative', ['Full-Time', 'International'], '4min', { hold: true })
            ] },
            outside: { label: 'Waiting Outside (2)', tickets: [
                t('Noah Tremblay', 'Student Advising', 'Service Hub Representative', ['Full-Time', 'Domestic'], '2min'),
                t('Sofia Rossi', 'Financial Aid', 'Service Hub Representative', ['Full-Time', 'International'], '0min')
            ] },
            desks: [
                ['X-Table 1 - A', 'Raika Ashraf'], ['X-Table 1 - B', 'Sara Khan'], ['X-Table 1 - C', 'Danni Gao'], ['X-Table 1 - D', 'Dena Cai'],
                ['X-Table 2 - A', 'Ramla Anwar Ali'], ['X-Table 2 - B', 'Dawn Vernon'], ['X-Table 2 - C', 'Jesse Mcleod'],
                ['Tall Table 2 - A', 'Jordan Grech'], ['Tall Table 2 - B', 'Tawab Sultanee'], ['Harvest Table 1 - B', 'Mina Park'], ['Harvest Table 1 - A', 'Rochelle Sylvestre'],
                ['Short Table 2', 'Omar Haddad'], ['D2005', 'Dildeep Sandhu']
            ].map(([table, rep]) => ({ table, rep })),
            served: [
                { ...t('Hope Oguikpe', 'Student Services', 'Service Hub Representative', [], '2min'), table: 'X-Table 1 - B', rep: 'Sara Khan', glowing: true },
                { ...t('Fausat Rirkefe', 'Registration', 'Service Hub Representative', [], '21min'), table: 'X-Table 1 - D', rep: 'Dena Cai', glowing: false },
                { ...t('Sarah Mohamed', 'Registration', 'Service Hub Representative', [], '3min'), table: 'Tall Table 2 - B', rep: 'Tawab Sultanee', glowing: false },
                { ...t('Grace Lee', 'Drop-In', 'Immigration', [], '6min'), table: 'D2005', rep: 'Dildeep Sandhu', glowing: false },
                { ...t('Evgenia Gladkovskaya', 'Registration', 'Registration Office', [], '4min'), table: 'Harvest Table 1 - A', rep: 'Rochelle Sylvestre', glowing: false }
            ],
            servedFound: true
        };
        const relabel = () => {
            state.inside.label = `Waiting Inside (${state.inside.tickets.length}/20)`;
            state.outside.label = `Waiting Outside (${state.outside.tickets.length})`;
            state.at = Date.now();
        };
        const moveIn = (key) => {
            const i = state.outside.tickets.findIndex((ticket) => ticket.key === key);
            if (i < 0) return { ok: false, error: 'That ticket is no longer outside' };
            state.inside.tickets.push(state.outside.tickets.splice(i, 1)[0]);
            relabel();
            setTimeout(render, 600);
            return { ok: true };
        };
        demo = {
            command: async (cmd) => {
                if (cmd.type === 'move-inside') return moveIn(cmd.key);
                if (cmd.type === 'move-next-inside') return state.outside.tickets[0] ? moveIn(state.outside.tickets[0].key) : { ok: false, error: 'No one is waiting outside' };
                if (cmd.type === 'clear-glow') return { ok: true };
                return { ok: false };
            }
        };
        board = state;
        calls = [
            { name: 'Grace Lee', table: 'D2005', rep: 'Dildeep Sandhu', at: Date.now() - 6 * 60000 },
            { name: 'Sarah Mohamed', table: 'Tall Table 2 - B', rep: 'Tawab Sultanee', at: Date.now() - 3 * 60000 },
            { name: 'Hope Oguikpe', table: 'X-Table 1 - B', rep: 'Sara Khan', at: Date.now() - 2 * 60000 }
        ];
        lastCallAt = Date.now();
        render();
        setInterval(() => {
            const next = state.inside.tickets.find((ticket) => !ticket.hold);
            if (!next) return;
            state.inside.tickets = state.inside.tickets.filter((ticket) => ticket !== next);
            const busy = new Set(state.served.map((ticket) => ticket.table));
            const free = state.desks.find((desk) => !busy.has(desk.table)) || state.desks[0];
            state.served = state.served.filter((ticket) => ticket.table !== free.table);
            state.served.push({ ...next, table: free.table, rep: free.rep, glowing: true });
            if (Math.random() < 0.7) state.outside.tickets.push(t('Daniel Kim', 'Registration', 'Registration Office', ['Full-Time', 'Domestic'], '0min'));
            relabel();
            calls = [...calls, { name: next.name, table: free.table, rep: free.rep, at: Date.now() }];
            render();
            checkNewCalls();
        }, 15000);
    };
    $('demoBtn').addEventListener('click', startDemo);

    renderAdmin();
    render();
    setInterval(render, 5000);
    const params = new URLSearchParams(location.search);
    if (params.has('demo') || !hasChrome) startDemo(); else load();
})();
