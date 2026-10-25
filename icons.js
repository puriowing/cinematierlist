/* Pickture - 絵文字を単色の線画アイコン（SVG）に置き換える */
(() => {
  const P = {
    help: '<circle cx="12" cy="12" r="9.5"/><path d="M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.6-2.8 4"/><path d="M12 17.3h.01"/>',
    swords: '<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6M16 16l4 4M19 21l2-2"/><path d="M14.5 6.5 18 3h3v3l-3.5 3.5"/><path d="m5 14 4 4M7 17l-3 3M3 19l2 2"/>',
    sword: '<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6M16 16l4 4M19 21l2-2"/>',
    upcoming: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="m11 13.5 3 2.5-3 2.5"/>',
    globe: '<circle cx="12" cy="12" r="9.5"/><path d="M12 2.5a14 14 0 0 0 0 19 14 14 0 0 0 0-19M2.5 12h19"/>',
    chart: '<path d="M3 3v18h18"/><path d="M8 17v-4M13 17V7M18 17v-7"/>',
    medal: '<circle cx="12" cy="15" r="6"/><path d="M8.6 10 5 3h4l3 6 3-6h4l-3.6 7"/><path d="M12 13v4"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    users: '<circle cx="9" cy="8" r="3.6"/><path d="M2.5 20.5a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.6 3.6 0 0 1 0 7M18 14.4a6.5 6.5 0 0 1 3.5 6.1"/>',
    refresh: '<path d="M20.5 12a8.5 8.5 0 0 1-15 5.4L3 15"/><path d="M3 20v-5h5"/><path d="M3.5 12a8.5 8.5 0 0 1 15-5.4L21 9"/><path d="M21 4v5h-5"/>',
    clock: '<circle cx="12" cy="12" r="9.5"/><path d="M12 6.5V12l3.5 2"/>',
    sparkle: '<path d="M12 3c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7z"/><path d="M19 15.5c.2 1.6.9 2.3 2.5 2.5-1.6.2-2.3.9-2.5 2.5-.2-1.6-.9-2.3-2.5-2.5 1.6-.2 2.3-.9 2.5-2.5z"/>',
    star: '<path d="m12 2.8 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3L12 17.3l-5.7 3 1.1-6.3-4.6-4.5 6.4-.9z"/>',
    target: '<circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="1.5"/>',
    trophy: '<path d="M7 3.5h10V9a5 5 0 0 1-10 0z"/><path d="M7 5.5H4a3 3 0 0 0 3 4.5M17 5.5h3a3 3 0 0 1-3 4.5"/><path d="M12 14v4M8 21h8M9.5 18h5"/>',
    megaphone: '<path d="M3 10v4a1 1 0 0 0 1 1h2l8 5V4L6 9H4a1 1 0 0 0-1 1z"/><path d="M17.5 9a4 4 0 0 1 0 6"/><path d="M6.5 15.2 8 21"/>',
    share: '<path d="M12 3v12"/><path d="m7.5 7.5 4.5-4.5 4.5 4.5"/><path d="M20 14v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5"/>',
    download: '<path d="M12 3v12"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M20 14v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-7H7v7M7 3v4h8"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.5-4.5"/>',
    clapper: '<path d="M3.5 10.5h17V19a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="m3.5 10.5-.6-2.9a1.6 1.6 0 0 1 1.2-1.9L17 3a1.6 1.6 0 0 1 1.9 1.2l.5 2.4z"/><path d="m8.2 5.1 2.4 3.4M13.4 4l2.4 3.4"/>',
    film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7.5 3v18M16.5 3v18M3 7.5h4.5M3 12h18M3 16.5h4.5M16.5 7.5H21M16.5 16.5H21"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
    pen: '<path d="M16.5 3.5a2.4 2.4 0 0 1 3.4 3.4L7.5 19.3 3 21l1.7-4.5z"/><path d="m14.5 5.5 3.4 3.4"/>',
    shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
    calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    masks: '<path d="M3 4h11v6a5.5 5.5 0 0 1-11 0z"/><path d="M14 8h7v6a5.5 5.5 0 0 1-9.6 3.6"/><path d="M6.5 8h.01M10.5 8h.01M6.8 11.6a2.6 2.6 0 0 0 3.4 0M16 11.5h.01M19 11.5h.01"/>',
    compare: '<path d="M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4"/>',
    tv: '<rect x="2.5" y="7" width="19" height="13.5" rx="2"/><path d="m16.5 2.5-4.5 4.5-4.5-4.5"/>',
    tag: '<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.5"/>',
    clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    bookmark: '<path d="M19 21l-7-4.5L5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    check: '<circle cx="12" cy="12" r="9.5"/><path d="m8 12.2 2.8 2.8L16.2 9"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    chat: '<path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.5L3 21l2-5.4A8.5 8.5 0 1 1 21 11.5z"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    offline: '<path d="m2 2 20 20"/><path d="M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5-2.7M19 12.9a10 10 0 0 0-2.2-1.5M2 8.8a15 15 0 0 1 4-2.5M22 8.8a15 15 0 0 0-11.3-3.7M12 20h.01"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    mail: '<rect x="2.5" y="4.5" width="19" height="15" rx="2"/><path d="m21.5 7-9.5 6-9.5-6"/>',
    heart: '<path d="M19.5 13.6C21 12.1 22 10.6 22 8.5A5.5 5.5 0 0 0 12 5.3 5.5 5.5 0 0 0 2 8.5c0 2.1 1 3.6 2.5 5.1L12 21z"/>',
    gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
    cart: '<circle cx="8" cy="20.5" r="1.3"/><circle cx="18" cy="20.5" r="1.3"/><path d="M2 2.5h3l2.6 12a2 2 0 0 0 2 1.5h8.8a2 2 0 0 0 2-1.5L22 6.5H6"/>',
    bolt: '<path d="M13 2 4 13.5h8L11 22l9-11.5h-8z"/>',
    crown: '<path d="M2.5 18 4 7l5 4.5L12 4l3 7.5L20 7l1.5 11z"/><path d="M4 21h16"/>',
    flame: '<path d="M12 22a7 7 0 0 0 7-7c0-2.5-1.2-4.4-2.6-6-.3 1.5-1.2 2.5-2.4 2.8C14.5 8 13 4.5 10 2c0 3.5-1.6 5.6-3.3 7.5A7.6 7.6 0 0 0 5 15a7 7 0 0 0 7 7z"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    bulb: '<path d="M9 18h6M10 21.5h4"/><path d="M12 2.5a6.5 6.5 0 0 0-3.8 11.8c.5.4.8 1 .8 1.7h6c0-.7.3-1.3.8-1.7A6.5 6.5 0 0 0 12 2.5z"/>',
    orbit: '<circle cx="12" cy="12" r="5"/><ellipse cx="12" cy="12" rx="10.5" ry="3.6" transform="rotate(-22 12 12)"/>',
    moon: '<path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.6 6.6 0 0 0 9.7 9.7z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    wave: '<path d="M2 7c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 12.5c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 18c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2"/>',
    skull: '<path d="M12 2.5a8 8 0 0 0-8 8c0 2.8 1.3 4.6 3 5.8V21h10v-4.7c1.7-1.2 3-3 3-5.8a8 8 0 0 0-8-8z"/><circle cx="9" cy="11" r="1.6"/><circle cx="15" cy="11" r="1.6"/><path d="M10.5 21v-2.5M13.5 21v-2.5"/>',
    crosshair: '<circle cx="12" cy="12" r="8.5"/><path d="M22 12h-4.5M6.5 12H2M12 6.5V2M12 22v-4.5"/>',
    shield: '<path d="M12 21.5s8-3.8 8-9.8V5.2L12 2.5 4 5.2v6.5c0 6 8 9.8 8 9.8z"/>',
    car: '<path d="M5 17.5H3V13l2-5.5h14l2 5.5v4.5h-2M9.5 17.5h5M3 13h18"/><circle cx="7.3" cy="17.5" r="2.2"/><circle cx="16.7" cy="17.5" r="2.2"/>',
    plane: '<path d="M10.5 21.5 12 17l2 .5v-5l8 2v-2.5L14 8V3.5a2 2 0 0 0-4 0V8L2 12v2.5l8-2v5l2-.5"/>',
    leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z"/><path d="M2 21c0-3 1.9-5.4 5.2-6"/>',
    paw: '<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.8 1C6.5 17.5 6.5 17.5 4.5 16.8A3.5 3.5 0 0 1 5.5 10z"/>',
    landmark: '<path d="M3 21.5h18M5.5 18v-7.5M10 18v-7.5M14 18v-7.5M18.5 18v-7.5M12 2.5l9 5.5H3z"/>',
    castle: '<path d="M4 21.5V8h3v2.5h2.5V8h5v2.5H17V8h3v13.5z"/><path d="M10 21.5v-5a2 2 0 0 1 4 0v5M12 8V3l3 1.5L12 6"/>',
    mountain: '<path d="M2 20.5 9 6l4.5 8 2.5-4 6 10.5z"/>',
    robot: '<rect x="4" y="8" width="16" height="12" rx="2.5"/><path d="M12 8V4.5M9 13v2M15 13v2M2 13v3M22 13v3"/><circle cx="12" cy="3.5" r="1"/>',
    dice: '<rect x="3" y="3" width="18" height="18" rx="3.5"/><path d="M8 8h.01M16 16h.01M12 12h.01M16 8h.01M8 16h.01" stroke-width="3"/>',
    puzzle: '<path d="M4 8h3.5a2.5 2.5 0 1 1 5 0H16v3.5a2.5 2.5 0 1 1 0 5V20h-3.5a2.5 2.5 0 1 0-5 0H4z"/>',
    hat: '<path d="M7 16V4.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1V16"/><path d="M2.5 16h19v2.5h-19zM7 12h10"/>',
    glasses: '<circle cx="6.5" cy="14.5" r="4"/><circle cx="17.5" cy="14.5" r="4"/><path d="M10.5 14a2 2 0 0 1 3 0M2.5 14 4 6.5M21.5 14 20 6.5"/>',
    face: '<circle cx="12" cy="12" r="9.5"/><path d="M8 14.5s1.5 2 4 2 4-2 4-2M9 9.5h.01M15 9.5h.01"/>',
    flag: '<path d="M4.5 22V3.5M4.5 4h13l-2.5 4.5 2.5 4.5h-13"/>',
    compass: '<circle cx="12" cy="12" r="9.5"/><path d="m16 8-2.2 5.8L8 16l2.2-5.8z"/>',
    gem: '<path d="M6 3.5h12l4 5.5-10 12L2 9z"/><path d="M2 9h20M12 21 8.5 9 12 3.5 15.5 9z"/>',
    ticket: '<path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4z"/><path d="M14 5v2.5M14 11v2M14 16.5V19"/>',
    bell: '<path d="M6 8.5a6 6 0 0 1 12 0c0 6.5 2.5 8.5 2.5 8.5h-17S6 15 6 8.5"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
    key: '<circle cx="7.5" cy="15.5" r="5"/><path d="m11 12 9.5-9.5M16 7l3 3M18.5 4.5l2 2"/>',
    tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
    cup: '<path d="M8 21.5h8M12 15v6.5M5.5 3h13L17.5 9a5.5 5.5 0 0 1-11 0z"/>',
    palette: '<path d="M12 2.5a9.5 9.5 0 0 0 0 19c1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.8-.5-1.2 0-1 .8-1.8 1.8-1.8h2.1a5.3 5.3 0 0 0 5.3-5.3c0-4.3-4.3-7.7-10-7.7z"/><path d="M7.5 12h.01M9 7.8h.01M13.8 6.8h.01M17.5 9.8h.01" stroke-width="3"/>',
    spiral: '<path d="M12 12a1.5 1.5 0 1 1 1.5 1.5A3 3 0 0 1 10.5 10.5 4.5 4.5 0 0 1 15 6a6 6 0 0 1 6 6 7.5 7.5 0 0 1-7.5 7.5A9 9 0 0 1 4.5 10.5"/>',
    web: '<path d="M12 2v20M2 12h20M4.9 4.9l14.2 14.2M19.1 4.9 4.9 19.1"/><path d="M12 6.5 16 8l1.5 4-1.5 4-4 1.5L8 16l-1.5-4L8 8z"/>',
    ghost: '<path d="M5 21V10a7 7 0 0 1 14 0v11l-2.3-2-2.4 2-2.3-2-2.3 2-2.4-2z"/><path d="M9.5 10h.01M14.5 10h.01" stroke-width="3"/>',
    rocket: '<path d="M12 2.5c3 2.2 4.5 5.4 4.5 9.5L14.5 17h-5l-2-5c0-4.1 1.5-7.3 4.5-9.5z"/><path d="M7.5 12 4.5 15v3.5l4-1.5M16.5 12l3 3v3.5l-4-1.5M10.5 20.5 12 22l1.5-1.5"/><circle cx="12" cy="9.5" r="1.6"/>',
    candle: '<path d="M8.5 21.5V10h7v11.5M6 21.5h12"/><path d="M12 10V7.5M12 2.5c1.3 1.5 1.8 2.3 1.8 3.2a1.8 1.8 0 0 1-3.6 0c0-.9.5-1.7 1.8-3.2z"/>',
    briefcase: '<rect x="2.5" y="7" width="19" height="13.5" rx="2"/><path d="M8.5 7V5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2M2.5 13h19"/>',
    news: '<path d="M4 4.5h13v15a1.5 1.5 0 0 0 3 0V9h-3"/><path d="M4 4.5v15A1.5 1.5 0 0 0 5.5 21h13M7.5 8.5h6M7.5 12.5h6M7.5 16.5h4"/>',
    scale: '<path d="M12 3v18M7 21h10M4 7h16M7 7l-3.5 7a3.5 3.5 0 0 0 7 0zM17 7l-3.5 7a3.5 3.5 0 0 0 7 0z"/>',
    door: '<path d="M5 21.5V4a1.5 1.5 0 0 1 1.5-1.5h11A1.5 1.5 0 0 1 19 4v17.5M3 21.5h18M15 12.5h.01"/>',
    drop: '<path d="M12 2.5S5.5 10 5.5 14.5a6.5 6.5 0 0 0 13 0C18.5 10 12 2.5 12 2.5z"/>',
    dna: '<path d="M7 2.5c0 6.5 10 6.5 10 13M17 21.5c0-6.5-10-6.5-10-13M7 21.5c0-2.5 1.2-4 2.8-5.1M17 2.5c0 2.5-1.2 4-2.8 5.1M8.5 6h7M8.5 18h7"/>',
    cloud: '<path d="M17.5 19H8a5.5 5.5 0 1 1 1.4-10.8A6 6 0 0 1 20.8 11a4 4 0 0 1-3.3 8z"/>',
    anchor: '<circle cx="12" cy="5" r="2.5"/><path d="M12 7.5V21.5M5 12H3a9 9 0 0 0 18 0h-2M8.5 11h7"/>',
    trident: '<path d="M12 22V6M5 3v4a7 7 0 0 0 14 0V3M12 2l-2 3h4z"/>',
    bow: '<path d="M4 20 20 4M14 4h6v6M4 3c6 0 17 11 17 17"/>',
    fist: '<path d="M7 11V7a1.8 1.8 0 0 1 3.6 0v3M10.6 7.5V6a1.8 1.8 0 0 1 3.6 0v4M14.2 7.5a1.8 1.8 0 0 1 3.6 0v6A7.5 7.5 0 0 1 10.3 21H10a6 6 0 0 1-5-2.8l-.6-1A3 3 0 0 1 7 13h3"/>',
    rainbow: '<path d="M2.5 18a9.5 9.5 0 0 1 19 0M6 18a6 6 0 0 1 12 0M9.5 18a2.5 2.5 0 0 1 5 0"/>',
    tent: '<path d="M12 3 2 21h20zM12 3v18M8.5 21 12 14l3.5 7"/>',
    snowman: '<circle cx="12" cy="7" r="3.5"/><circle cx="12" cy="16" r="5.5"/>',
    city: '<path d="M3 21.5h18M5 21.5V8.5h5v13M10 21.5V3.5h9v18M13 7.5h3M13 11.5h3M13 15.5h3M7.5 12.5h.01M7.5 16.5h.01"/>',
    road: '<path d="M8 3 4 21M16 3l4 18M12 4v2.5M12 10.5v3M12 17.5V20"/>',
    hourglass: '<path d="M6 2.5h12M6 21.5h12M7 2.5c0 5.5 10 5.5 10 9.5S7 16 7 21.5M17 2.5c0 5.5-10 5.5-10 9.5s10 4 10 9.5"/>',
    family: '<circle cx="7" cy="6" r="2.6"/><circle cx="17" cy="6" r="2.6"/><circle cx="12" cy="12.5" r="2"/><path d="M2.5 20a4.5 4.5 0 0 1 4.5-5.5M21.5 20a4.5 4.5 0 0 0-4.5-5.5M8.5 21a3.5 3.5 0 0 1 7 0"/>',
    disc: '<circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="12" r="2.5"/>',
    badge: '<path d="M12 2.5 14.6 4.4 17.8 4.3 18.8 7.4 21.3 9.4 20.3 12.5 21.3 15.6 18.8 17.6 17.8 20.7 14.6 20.6 12 22.5 9.4 20.6 6.2 20.7 5.2 17.6 2.7 15.6 3.7 12.5 2.7 9.4 5.2 7.4 6.2 4.3 9.4 4.4z"/>',
    coin: '<circle cx="12" cy="12" r="9.5"/><path d="M15 8.5c-.6-.9-1.7-1.5-3-1.5-1.9 0-3.2 1-3.2 2.5 0 3.3 6.4 1.7 6.4 5 0 1.5-1.4 2.5-3.2 2.5-1.4 0-2.6-.6-3.2-1.6M12 5v2M12 17v2"/>',
    dot: '<path d="M12 4.5 19.5 12 12 19.5 4.5 12z"/>',
  };

  const G = {
    help: "❓❔", swords: "⚔", sword: "🗡🔪🥷", upcoming: "🔮", globe: "🌐🌏🌍🗺🌎", chart: "📊📈📉",
    medal: "🏅🎖🏵", user: "👤🕴🧙🦸👮", users: "👥", refresh: "🔄♻↻🔁", clock: "🕰⏰⌚",
    sparkle: "✨💫🌠🆕🎇", star: "⭐🌟💯", target: "🎯", trophy: "🏆", megaphone: "📣📢🎤",
    share: "📤", download: "⬇📥", save: "💾", folder: "📂📁🗂🗄", search: "🔍🔎", clapper: "🎬",
    film: "🎞🎥🎦📽", book: "📚📖📓", pen: "✍✎🖍✏", shuffle: "🔀", calendar: "📅🗓📆",
    masks: "🎭", compare: "🤝⇄", tv: "📺", tag: "🏷", camera: "📷📸", clipboard: "📋",
    home: "🏠🏡", bookmark: "🔖", check: "✅✔☑", gear: "⚙", chat: "💬🗨", alert: "⚠🚨",
    offline: "📴", link: "🔗", mail: "📩📨✉📧", heart: "💞💕💚🩶❤💗💖🌹", gift: "🎁🎀",
    cart: "🛒", bolt: "⚡💥💪", crown: "👑", flame: "🔥🧨🚬", music: "🎵🎶🎷🎸🎹🎻",
    bulb: "💡", orbit: "🌌🪐🛸", moon: "🌙🌃", sun: "☀🌞", wave: "🌊🌫", skull: "💀☠🧟🧛🎃😱👹🩸",
    crosshair: "🔫💣", shield: "🛡🚔", car: "🚗🚙🏎🏍🚕", plane: "✈", leaf: "🌸🌷🌼🌿🍁🌾🌴🌽🌱🎄🎐",
    paw: "🐺🐕🦁🐢🦇🐶🐻🐼🐷🦊🐦🐬🐟🦈🦋🦝🦉🐜🐉🐲🦖🦕🦣🐾", landmark: "🏛", castle: "🏰🏯🎡",
    mountain: "⛰🏔🏜🗾", robot: "🤖👾", dice: "🎲🃏🀄🎰🎳", puzzle: "🧩", hat: "🎩🤠",
    glasses: "🕶😎🕵", face: "😢😂😴🤫🙂😊", flag: "🎌🏴🏳🎏", compass: "🧭", gem: "💍💎💠",
    ticket: "🎟🎫", bell: "🔔", key: "🗝🔑", tool: "🪚🔨🧱🧹✂🛢", cup: "🍸🍷🍻🍵🍦🍬🍭🍌🍿",
    palette: "🎨", spiral: "🌀", web: "🕸🕷", ghost: "👻", rocket: "🚀", candle: "🕯",
    briefcase: "💼", news: "📰", scale: "⚖", door: "🚪🕳", drop: "💧", dna: "🧬", cloud: "☁",
    anchor: "⚓", trident: "🔱", bow: "🏹", fist: "✊👊🥊🥋", rainbow: "🌈", tent: "🎪",
    snowman: "🧸⛄🎈", city: "🏙🌆", road: "🛣", hourglass: "⏳⌛", family: "👨‍👩‍👧",
    disc: "📀💿", badge: "🆓🈁🅰🟣", coin: "💰🪙",
  };

  const MAP = new Map();
  const norm = (s) => s.replace(/️/g, "");
  for (const [name, list] of Object.entries(G)) {
    for (const e of list.match(/\p{Extended_Pictographic}(?:‍\p{Extended_Pictographic})*|./gu)) {
      MAP.set(norm(e), name);
    }
  }

  const svg = (inner) =>
    `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const medal = (n) => svg(`<circle cx="12" cy="12" r="9.5"/><text x="12" y="16.2" text-anchor="middle" font-size="11.5" font-weight="800" fill="currentColor" stroke="none" font-family="Montserrat,sans-serif">${n}</text>`);

  const KEEP_TEXT = new Set(["↔", "↕", "↖", "↗", "↘", "↙", "↩", "↪", "©", "®", "™", "‼", "⁉", "▶", "◀", "▪", "▫", "◻", "◼", "Ⓜ", "★", "☆", "〰", "〽", "㊗", "㊙", "‼"]);
  const RE = /[\u{1F1E6}-\u{1F1FF}]{2}|\p{Extended_Pictographic}️?(?:‍\p{Extended_Pictographic}️?)*/gu;
  const TEST = /[\u{1F1E6}-\u{1F1FF}]|\p{Extended_Pictographic}/u;

  function iconFor(seq) {
    const k = norm(seq);
    if (k === "🥇") return medal(1);
    if (k === "🥈") return medal(2);
    if (k === "🥉") return medal(3);
    if (/^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test(k)) return svg(P.flag);
    const name = MAP.get(k) || MAP.get([...k][0]);
    return svg(P[name || "dot"]);
  }

  function shouldKeep(seq) {
    return KEEP_TEXT.has(seq) || (seq.length === 1 && seq.charCodeAt(0) < 0x2600 && !MAP.has(seq));
  }

  function stripText(s) {
    return s.replace(RE, (m) => (shouldKeep(m) ? m : "")).replace(/️/g, "").replace(/\s{2,}/g, " ").trim();
  }

  const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "NOSCRIPT"]);

  function convertTextNode(node) {
    const text = node.nodeValue;
    if (!text || !TEST.test(text)) return;
    const parent = node.parentNode;
    if (!parent || SKIP.has(parent.nodeName)) return;
    if (parent.closest && parent.closest("svg")) return;
    if (parent.nodeName === "OPTION" || parent.nodeName === "TITLE") {
      node.nodeValue = stripText(text);
      return;
    }
    let html = "";
    let last = 0;
    let changed = false;
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    text.replace(RE, (m, idx) => {
      if (shouldKeep(m)) return m;
      html += esc(text.slice(last, idx)) + iconFor(m);
      last = idx + m.length;
      changed = true;
      return m;
    });
    if (!changed) return;
    html += esc(text.slice(last));
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    parent.replaceChild(tpl.content, node);
  }

  const ATTRS = ["title", "placeholder", "aria-label", "alt"];
  function cleanAttrs(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && TEST.test(v)) {
        const nv = stripText(v).trim();
        if (nv !== v) el.setAttribute(a, nv);
      }
    }
  }

  function process(root) {
    if (!root) return;
    if (root.nodeType === 3) return convertTextNode(root);
    if (root.nodeType !== 1 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      if (SKIP.has(root.nodeName) && root.nodeName !== "INPUT" && root.nodeName !== "TEXTAREA") return;
      cleanAttrs(root);
      if (root.nodeName === "svg") return;
    }
    if (root.querySelectorAll) root.querySelectorAll("[title],[placeholder],[aria-label],[alt]").forEach(cleanAttrs);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const list = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (TEST.test(n.nodeValue)) list.push(n);
    list.forEach(convertTextNode);
  }

  window.picktureIcon = (name) => svg(P[name] || P.dot);
  window.picktureIconize = process;

  function start() {
    process(document.body);
    if (TEST.test(document.title)) document.title = stripText(document.title).trim();
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "childList") m.addedNodes.forEach(process);
        else if (m.type === "characterData") convertTextNode(m.target);
        else if (m.type === "attributes") cleanAttrs(m.target);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
