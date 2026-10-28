// Floor map of the Service Hub on a 1200 x 720 grid, laid out like the real floor plan
// (Faculty Hub side on the right). Only the seats reps use are drawn.
//
// To add or move a seat: add it to `seats` with a box (x, y, w, h), an id and a kind
// (table = orange, desk = purple, booth = brown). Waitwell table names are matched to
// seat ids by seatIdFor() below, e.g. "X-Table 2 - B" -> "x2-b",
// "Harvest Table 1 - A" -> "harvest1-a", "Short Table 3" -> "short3", "D2322" -> "d2322".
window.FLOOR_MAP = {
    width: 1200,
    height: 720,
    wall: { x: 10, y: 10, w: 1180, h: 700 },

    zones: [
        { label: 'VOC Booths', x: 25, y: 30, w: 110, h: 215 },
        { label: 'Harvest Tables', x: 150, y: 30, w: 280, h: 235 },
        { label: 'Short Tables', x: 150, y: 285, w: 655, h: 120 },
        { label: 'Semi-Private', x: 25, y: 425, w: 280, h: 275 },
        { label: 'Harvest Table 3', x: 320, y: 425, w: 485, h: 150 },
        { label: 'Consultation Rooms', x: 320, y: 590, w: 485, h: 110 },
        { label: 'Service Hub Representative Area', x: 825, y: 30, w: 355, h: 560, labelY: 318 },
        { label: 'Tall Table 2', x: 825, y: 600, w: 355, h: 100 }
    ],

    // Box for desks that aren't on this map (e.g. D2005)
    other: { x: 445, y: 30, w: 360, h: 235 },

    seats: [
        // VOC booths
        { id: 'voc1', label: 'Booth 1', kind: 'booth', x: 35, y: 56, w: 90, h: 86 },
        { id: 'voc2', label: 'Booth 2', kind: 'booth', x: 35, y: 150, w: 90, h: 86 },
        // Harvest Tables 1 and 2: B towards the top, A towards the bottom
        { id: 'harvest1-b', label: '1 · B', kind: 'table', x: 162, y: 54, w: 125, h: 98 },
        { id: 'harvest1-a', label: '1 · A', kind: 'table', x: 162, y: 158, w: 125, h: 98 },
        { id: 'harvest2-b', label: '2 · B', kind: 'table', x: 295, y: 54, w: 125, h: 98 },
        { id: 'harvest2-a', label: '2 · A', kind: 'table', x: 295, y: 158, w: 125, h: 98 },
        // Short Tables
        ...[1, 2, 3, 4].map((n) => ({ id: `short${n}`, label: `${n}`, kind: 'table', x: 162 + (n - 1) * 160, y: 312, w: 150, h: 84 })),
        // Semi-Private
        ...[1, 2, 3].map((n) => ({ id: `semi${n}`, label: `${n}`, kind: 'desk', x: 37, y: 452 + (n - 1) * 80, w: 256, h: 72 })),
        // Harvest Table 3: B top, A bottom
        { id: 'harvest3-b', label: 'B', kind: 'table', x: 335, y: 452, w: 455, h: 56 },
        { id: 'harvest3-a', label: 'A', kind: 'table', x: 335, y: 514, w: 455, h: 56 },
        // Consultation rooms + Tall Table 1
        { id: 'tall1', label: 'Tall Table 1', kind: 'table', x: 332, y: 614, w: 108, h: 80 },
        { id: 'd2324', label: 'D2324', kind: 'desk', x: 448, y: 614, w: 108, h: 80 },
        { id: 'd2323', label: 'D2323', kind: 'desk', x: 564, y: 614, w: 108, h: 80 },
        { id: 'd2322', label: 'D2322', kind: 'desk', x: 680, y: 614, w: 113, h: 80 },
        // X-Table 1 (A top, B right, C bottom, D left)
        { id: 'x1-a', label: 'A', kind: 'desk', x: 923, y: 52, w: 160, h: 72 },
        { id: 'x1-d', label: 'D', kind: 'desk', x: 838, y: 132, w: 160, h: 72 },
        { id: 'x1-b', label: 'B', kind: 'desk', x: 1008, y: 132, w: 160, h: 72 },
        { id: 'x1-c', label: 'C', kind: 'desk', x: 923, y: 212, w: 160, h: 72 },
        // X-Table 2
        { id: 'x2-a', label: 'A', kind: 'desk', x: 923, y: 336, w: 160, h: 72 },
        { id: 'x2-d', label: 'D', kind: 'desk', x: 838, y: 416, w: 160, h: 72 },
        { id: 'x2-b', label: 'B', kind: 'desk', x: 1008, y: 416, w: 160, h: 72 },
        { id: 'x2-c', label: 'C', kind: 'desk', x: 923, y: 496, w: 160, h: 72 },
        // Tall Table 2
        { id: 'tall2-a', label: 'A', kind: 'table', x: 838, y: 624, w: 160, h: 68 },
        { id: 'tall2-b', label: 'B', kind: 'table', x: 1008, y: 624, w: 160, h: 68 }
    ],

    // Names written beside each X-Table cross
    groupLabels: [
        { text: 'X-Table 1', x: 840, y: 96 },
        { text: 'X-Table 2', x: 840, y: 380 }
    ]
};

// Waitwell table name -> seat id on the map ('' when it isn't on the map).
window.seatIdFor = (table) => {
    const t = (table || '').toLowerCase().replace(/[–—]/g, '-');
    let m;
    if ((m = t.match(/x\s*-?\s*table\s*(\d+)\s*-?\s*([a-d])\b/))) return `x${m[1]}-${m[2]}`;
    if ((m = t.match(/tall\s*table\s*(\d+)\s*(?:-\s*)?([a-d])?\b/))) return m[2] ? `tall${m[1]}-${m[2]}` : `tall${m[1]}`;
    if ((m = t.match(/harvest\s*(?:table)?\s*(\d+)\s*(?:-\s*)?([ab])?\b/))) return m[2] ? `harvest${m[1]}-${m[2]}` : `harvest${m[1]}`;
    if ((m = t.match(/short\s*table\s*(\d+)/))) return `short${m[1]}`;
    if ((m = t.match(/semi\s*-?\s*private\s*(\d+)/))) return `semi${m[1]}`;
    if ((m = t.match(/(?:voc|sound)\s*(?:booth)?\s*(\d+)/))) return `voc${m[1]}`;
    if ((m = t.match(/\bd\s*-?\s*(\d{4})\b/))) return `d${m[1]}`;
    return '';
};
