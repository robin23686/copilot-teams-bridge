const fs = require('fs');
const path = require('path');

const outDir = __dirname;
const iconData = Object.fromEntries(
  ['vscode', 'copilot', 'teams'].map((name) => [
    name,
    fs.readFileSync(path.join(outDir, 'icons', `${name}.png`)).toString('base64'),
  ])
);

const palette = {
  ink: '#111827',
  muted: '#667085',
  purple: '#6264A7',
  purpleDark: '#464775',
  purpleLight: '#EEEDFA',
  blue: '#2563EB',
  cyan: '#36C5F0',
  green: '#16A34A',
  greenLight: '#ECFDF3',
  amber: '#F59E0B',
  surface: '#FFFFFF',
  canvas: '#F5F7FB',
  border: '#DCE2EE',
};

function escapeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function productIcon(name, x, y, size) {
  return `<image x="${x}" y="${y}" width="${size}" height="${size}" href="data:image/png;base64,${iconData[name]}"/>`;
}

function text(x, y, value, size, weight = 400, fill = palette.ink, anchor = 'start') {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
}

function multiline(x, y, lines, size, lineHeight, weight = 400, fill = palette.ink, anchor = 'start') {
  return lines
    .map((line, index) => text(x, y + index * lineHeight, line, size, weight, fill, anchor))
    .join('\n');
}

function iconBadge(x, y, letter, fill, label) {
  return `
    <rect x="${x}" y="${y}" width="64" height="64" rx="16" fill="${fill}"/>
    ${text(x + 32, y + 43, letter, 30, 700, '#FFFFFF', 'middle')}
    ${label ? text(x + 82, y + 40, label, 24, 600) : ''}`;
}

function defs() {
  return `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#F7F7FF"/>
      <stop offset="0.48" stop-color="#F5F7FB"/>
      <stop offset="1" stop-color="#EAF7FC"/>
    </linearGradient>
    <linearGradient id="purpleGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7B83EB"/>
      <stop offset="1" stop-color="#464775"/>
    </linearGradient>
    <linearGradient id="blueGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4F8CFF"/>
      <stop offset="1" stop-color="#1D4ED8"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">
      <feDropShadow dx="0" dy="18" stdDeviation="24" flood-color="#17213A" flood-opacity="0.16"/>
    </filter>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#17213A" flood-opacity="0.12"/>
    </filter>
    <marker id="arrowPurple" markerWidth="14" markerHeight="10" refX="12" refY="5" orient="auto">
      <path d="M0 0 L14 5 L0 10 Z" fill="${palette.purple}"/>
    </marker>
    <marker id="arrowGreen" markerWidth="14" markerHeight="10" refX="12" refY="5" orient="auto">
      <path d="M0 0 L14 5 L0 10 Z" fill="${palette.green}"/>
    </marker>
  </defs>`;
}

function frame(content, eyebrow, title, subtitle, dark = false) {
  const bg = dark ? '#111827' : 'url(#bg)';
  const heading = dark ? '#FFFFFF' : palette.ink;
  const sub = dark ? '#C9D2E3' : palette.muted;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080" font-family="Segoe UI, Arial, sans-serif">
    ${defs()}
    <rect width="1920" height="1080" fill="${bg}"/>
    <circle cx="1740" cy="90" r="280" fill="${dark ? '#202A44' : '#E8E7FB'}" opacity="0.7"/>
    <circle cx="130" cy="1010" r="260" fill="${dark ? '#172554' : '#E5F6FC'}" opacity="0.75"/>
    ${eyebrow ? text(960, 74, eyebrow.toUpperCase(), 22, 700, dark ? '#A9B4FF' : palette.purple, 'middle') : ''}
    ${text(960, 145, title, 58, 750, heading, 'middle')}
    ${subtitle ? text(960, 198, subtitle, 27, 400, sub, 'middle') : ''}
    ${content}
  </svg>`;
}

function laptop(x, y, scale = 1) {
  const w = 980 * scale;
  const h = 590 * scale;
  const sx = (n) => x + n * scale;
  const sy = (n) => y + n * scale;
  return `
    <g filter="url(#shadow)">
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${24 * scale}" fill="#171B26"/>
      <rect x="${sx(18)}" y="${sy(18)}" width="${944 * scale}" height="${540 * scale}" rx="${12 * scale}" fill="#FFFFFF"/>
      <rect x="${sx(18)}" y="${sy(18)}" width="${944 * scale}" height="${62 * scale}" rx="${12 * scale}" fill="#202533"/>
      <circle cx="${sx(48)}" cy="${sy(49)}" r="${8 * scale}" fill="#FF605C"/>
      <circle cx="${sx(74)}" cy="${sy(49)}" r="${8 * scale}" fill="#FFBD44"/>
      <circle cx="${sx(100)}" cy="${sy(49)}" r="${8 * scale}" fill="#00CA4E"/>
      ${productIcon('vscode', sx(130), sy(30), 36 * scale)}
      ${text(sx(178), sy(57), 'VS Code  |  Copilot Chat', 22 * scale, 600, '#E8ECF5')}
      <rect x="${sx(42)}" y="${sy(110)}" width="${188 * scale}" height="${420 * scale}" rx="${10 * scale}" fill="#F1F3F8"/>
      ${text(sx(66), sy(150), 'EXPLORER', 14 * scale, 700, '#71798C')}
      ${text(sx(66), sy(188), 'src', 18 * scale, 600)}
      ${text(sx(84), sy(222), 'api', 17 * scale, 400, palette.muted)}
      ${text(sx(102), sy(255), 'filters.ts', 17 * scale, 400, palette.muted)}
      ${text(sx(84), sy(290), 'test', 17 * scale, 400, palette.muted)}
      <rect x="${sx(258)}" y="${sy(108)}" width="${674 * scale}" height="${96 * scale}" rx="${14 * scale}" fill="#EDF2FF"/>
      ${text(sx(282), sy(142), 'You', 16 * scale, 700, palette.blue)}
      ${text(sx(282), sy(177), 'Add a solutionArea filter and cover it with tests.', 20 * scale, 600)}
      <rect x="${sx(258)}" y="${sy(228)}" width="${674 * scale}" height="${178 * scale}" rx="${14 * scale}" fill="#FFFFFF" stroke="${palette.border}"/>
      ${productIcon('copilot', sx(282), sy(254), 64 * scale)}
      ${text(sx(362), sy(278), 'GitHub Copilot', 18 * scale, 700)}
      ${text(sx(362), sy(310), 'I will update the endpoint and add coverage.', 18 * scale, 400, palette.muted)}
      <rect x="${sx(362)}" y="${sy(340)}" width="${380 * scale}" height="${12 * scale}" rx="${6 * scale}" fill="#E8ECF5"/>
      <rect x="${sx(362)}" y="${sy(340)}" width="${245 * scale}" height="${12 * scale}" rx="${6 * scale}" fill="${palette.blue}"/>
      ${text(sx(362), sy(385), 'Working... running tests', 16 * scale, 600, palette.blue)}
      <rect x="${sx(258)}" y="${sy(430)}" width="${674 * scale}" height="${82 * scale}" rx="${14 * scale}" fill="#F8FAFC" stroke="${palette.border}"/>
      ${text(sx(282), sy(480), 'Ask Copilot...', 18 * scale, 400, '#98A2B3')}
      <circle cx="${sx(914)}" cy="${sy(484)}" r="${18 * scale}" fill="${palette.blue}"/>
      <path d="M${sx(906)} ${sy(484)} L${sx(914)} ${sy(476)} L${sx(922)} ${sy(484)}" fill="none" stroke="#FFF" stroke-width="${3 * scale}"/>
      <path d="M${sx(-45)} ${sy(590)} L${sx(1025)} ${sy(590)} L${sx(900)} ${sy(650)} L${sx(80)} ${sy(650)} Z" fill="#CED3DE"/>
      <rect x="${sx(410)}" y="${sy(603)}" width="${160 * scale}" height="${12 * scale}" rx="${6 * scale}" fill="#AEB6C5"/>
    </g>`;
}

function phone(x, y, scale = 1, state = 'notify') {
  const sx = (n) => x + n * scale;
  const sy = (n) => y + n * scale;
  const message =
    state === 'reply'
      ? `
        <rect x="${sx(40)}" y="${sy(354)}" width="${330 * scale}" height="${126 * scale}" rx="${18 * scale}" fill="${palette.purpleLight}"/>
        ${text(sx(62), sy(388), 'Copilot Teams Bridge', 16 * scale, 700, palette.purple)}
        ${text(sx(62), sy(420), 'Tests pass. Ship it, or add', 17 * scale, 500)}
        ${text(sx(62), sy(447), 'a retry with backoff?', 17 * scale, 500)}
        <rect x="${sx(122)}" y="${sy(510)}" width="${248 * scale}" height="${94 * scale}" rx="${18 * scale}" fill="${palette.purple}"/>
        ${text(sx(144), sy(547), 'You', 15 * scale, 700, '#DCDCF4')}
        ${text(sx(144), sy(578), 'Add the retry too.', 18 * scale, 500, '#FFFFFF')}
        <rect x="${sx(40)}" y="${sy(640)}" width="${330 * scale}" height="${60 * scale}" rx="${30 * scale}" fill="#F3F4F6" stroke="${palette.border}"/>
        ${text(sx(66), sy(678), 'Reply...', 17 * scale, 400, '#98A2B3')}
        <circle cx="${sx(338)}" cy="${sy(670)}" r="${22 * scale}" fill="${palette.purple}"/>
        <path d="M${sx(329)} ${sy(670)} L${sx(338)} ${sy(661)} L${sx(347)} ${sy(670)}" fill="none" stroke="#FFF" stroke-width="${3 * scale}"/>`
      : `
        <rect x="${sx(40)}" y="${sy(350)}" width="${330 * scale}" height="${158 * scale}" rx="${18 * scale}" fill="#FFFFFF" stroke="${palette.border}" filter="url(#softShadow)"/>
        ${productIcon('teams', sx(62), sy(374), 64 * scale)}
        ${text(sx(142), sy(398), 'Microsoft Teams', 16 * scale, 700)}
        ${text(sx(62), sy(456), '@You  Copilot started a task', 17 * scale, 700, palette.purple)}
        ${text(sx(62), sy(486), 'Add a solutionArea filter...', 16 * scale, 400, palette.muted)}
        <rect x="${sx(40)}" y="${sy(540)}" width="${330 * scale}" height="${172 * scale}" rx="${18 * scale}" fill="${palette.purpleLight}"/>
        ${text(sx(62), sy(575), 'Copilot Teams Bridge', 16 * scale, 700, palette.purple)}
        ${text(sx(62), sy(612), 'Working in VS Code', 18 * scale, 600)}
        ${text(sx(62), sy(644), 'I will post here when I finish', 16 * scale, 400, palette.muted)}
        ${text(sx(62), sy(671), 'or need your decision.', 16 * scale, 400, palette.muted)}`;
  return `
    <g filter="url(#shadow)">
      <rect x="${x}" y="${y}" width="${410 * scale}" height="${790 * scale}" rx="${58 * scale}" fill="#171B26"/>
      <rect x="${sx(14)}" y="${sy(14)}" width="${382 * scale}" height="${762 * scale}" rx="${46 * scale}" fill="#F8FAFC"/>
      <rect x="${sx(140)}" y="${sy(26)}" width="${130 * scale}" height="${26 * scale}" rx="${13 * scale}" fill="#171B26"/>
      ${text(sx(48), sy(90), '9:41', 17 * scale, 700)}
      ${text(sx(362), sy(90), '5G', 15 * scale, 700, palette.muted, 'end')}
      <rect x="${sx(14)}" y="${sy(112)}" width="${382 * scale}" height="${184 * scale}" fill="url(#purpleGrad)"/>
      ${productIcon('teams', sx(42), sy(142), 64 * scale)}
      ${text(sx(122), sy(173), 'Microsoft Teams', 22 * scale, 700, '#FFFFFF')}
      ${text(sx(42), sy(236), 'Copilot · solutionArea filter', 18 * scale, 600, '#FFFFFF')}
      ${text(sx(42), sy(266), 'One session, one thread', 15 * scale, 400, '#DCDCF4')}
      ${message}
      <rect x="${sx(150)}" y="${sy(744)}" width="${110 * scale}" height="${6 * scale}" rx="${3 * scale}" fill="#1F2937"/>
    </g>`;
}

const hero = frame(
  `
    ${laptop(120, 278, 1.04)}
    ${phone(1370, 245, 0.88, 'notify')}
    <path d="M1185 480 C1280 430 1300 410 1360 420" fill="none" stroke="${palette.purple}" stroke-width="8" stroke-linecap="round" marker-end="url(#arrowPurple)"/>
    <rect x="1120" y="345" width="250" height="68" rx="34" fill="#FFFFFF" stroke="${palette.border}" filter="url(#softShadow)"/>
    ${text(1245, 388, 'Teams notification', 20, 700, palette.purple, 'middle')}
  `,
  'Hackathon concept',
  'Your coding agent can reach you anywhere',
  'Copilot works in VS Code. You supervise from Microsoft Teams.'
);

const notify = frame(
  `
    <g transform="translate(180 280)">
      <rect width="640" height="560" rx="34" fill="#FFFFFF" stroke="${palette.border}" filter="url(#shadow)"/>
      ${productIcon('copilot', 58, 52, 64)}
      ${text(140, 92, 'Copilot is working', 24, 600)}
      ${text(58, 162, 'Add a solutionArea filter', 34, 700)}
      ${text(58, 208, 'and cover it with tests', 34, 700)}
      <rect x="58" y="262" width="524" height="18" rx="9" fill="#E8ECF5"/>
      <rect x="58" y="262" width="338" height="18" rx="9" fill="${palette.blue}"/>
      ${text(58, 330, 'You do not have to watch this screen.', 24, 500, palette.muted)}
      <rect x="58" y="390" width="524" height="102" rx="18" fill="#F7F8FC"/>
      ${text(86, 430, '14 min elapsed', 18, 700, palette.blue)}
      ${text(86, 466, 'Editing 3 files · running 4 tests', 20, 500)}
    </g>
    ${phone(1130, 244, 0.9, 'notify')}
    <path d="M838 515 C945 515 1012 480 1115 465" fill="none" stroke="${palette.purple}" stroke-width="8" stroke-linecap="round" marker-end="url(#arrowPurple)"/>
  `,
  'Step 1',
  'Walk away without losing the moment',
  'The session opens its own Teams thread and tags you.'
);

const replyAnywhere = frame(
  `
    <rect x="0" y="0" width="1920" height="1080" fill="url(#bg)" opacity="0"/>
    <g transform="translate(120 270)">
      <rect width="820" height="610" rx="40" fill="#FFF" stroke="${palette.border}" filter="url(#shadow)"/>
      <circle cx="142" cy="162" r="66" fill="#F2C7A5"/>
      <path d="M86 150 C92 68 202 66 214 150 C184 122 122 120 86 150" fill="#342720"/>
      <path d="M78 260 C110 208 204 208 236 260 L280 482 L34 482 Z" fill="url(#blueGrad)"/>
      <path d="M204 294 C256 326 292 340 342 344" fill="none" stroke="#F2C7A5" stroke-width="34" stroke-linecap="round"/>
      <rect x="260" y="292" width="154" height="268" rx="28" fill="#202533" transform="rotate(-8 337 426)"/>
      <rect x="274" y="312" width="126" height="224" rx="20" fill="#F8FAFC" transform="rotate(-8 337 426)"/>
      ${text(450, 94, 'In a meeting?', 34, 750)}
      ${text(450, 142, 'On the train?', 34, 750)}
      ${text(450, 190, 'Getting coffee?', 34, 750)}
      ${multiline(450, 246, ['A five-second decision should not', 'block the agent for an hour.'], 22, 32, 500, palette.muted)}
      <rect x="450" y="354" width="316" height="112" rx="18" fill="${palette.greenLight}" stroke="#B7E4C7"/>
      ${text(478, 396, 'Reply from Teams', 20, 700, palette.green)}
      ${text(478, 434, '"Add the retry too."', 25, 600)}
    </g>
    ${phone(1235, 243, 0.92, 'reply')}
  `,
  'Step 2',
  'Unblock Copilot from your phone',
  'Reply naturally. No session ID, no @mention, no copy-paste.'
);

const resume = frame(
  `
    ${laptop(255, 278, 1.08)}
    <rect x="920" y="510" width="680" height="150" rx="22" fill="${palette.greenLight}" stroke="#B7E4C7" stroke-width="2" filter="url(#softShadow)"/>
    ${productIcon('teams', 954, 548, 64)}
    ${text(1040, 574, 'Reply received from Teams', 20, 700, palette.purple)}
    ${text(1040, 617, '"Add the retry too."', 28, 650)}
    <path d="M920 620 C820 675 728 686 612 648" fill="none" stroke="${palette.green}" stroke-width="8" stroke-linecap="round" marker-end="url(#arrowGreen)"/>
    <rect x="472" y="680" width="630" height="82" rx="20" fill="${palette.green}" filter="url(#softShadow)"/>
    ${text(787, 731, 'Copilot resumes the same session', 25, 700, '#FFFFFF', 'middle')}
  `,
  'Step 3',
  'Your reply becomes the next instruction',
  'It returns to the exact session that asked. Work continues automatically.'
);

const closing = frame(
  `
    <g transform="translate(190 280)">
      <rect width="1540" height="560" rx="42" fill="#1C2438" stroke="#303B55" filter="url(#shadow)"/>
      <g transform="translate(80 72)">
        <rect width="410" height="164" rx="24" fill="#273149"/>
        ${iconBadge(28, 34, '1', '#4F8CFF', '')}
        ${text(110, 68, 'API filter', 23, 700, '#FFFFFF')}
        ${text(110, 104, 'Tests running', 18, 500, '#A9B4C7')}
        <circle cx="372" cy="82" r="10" fill="${palette.amber}"/>
      </g>
      <g transform="translate(565 72)">
        <rect width="410" height="164" rx="24" fill="#273149"/>
        ${iconBadge(28, 34, '2', '#7B83EB', '')}
        ${text(110, 68, 'Docs update', 23, 700, '#FFFFFF')}
        ${text(110, 104, 'Waiting for reply', 18, 500, '#A9B4C7')}
        <circle cx="372" cy="82" r="10" fill="${palette.purple}"/>
      </g>
      <g transform="translate(1050 72)">
        <rect width="410" height="164" rx="24" fill="#273149"/>
        ${iconBadge(28, 34, '3', '#16A34A', '')}
        ${text(110, 68, 'Retry logic', 23, 700, '#FFFFFF')}
        ${text(110, 104, 'Completed', 18, 500, '#A9B4C7')}
        <circle cx="372" cy="82" r="10" fill="${palette.green}"/>
      </g>
      <path d="M285 270 L285 340 L770 340" fill="none" stroke="#7B83EB" stroke-width="4"/>
      <path d="M770 270 L770 340" fill="none" stroke="#7B83EB" stroke-width="4"/>
      <path d="M1255 270 L1255 340 L770 340" fill="none" stroke="#7B83EB" stroke-width="4"/>
      <rect x="460" y="346" width="620" height="122" rx="26" fill="url(#purpleGrad)"/>
      ${text(770, 394, 'One session  <->  one Teams thread', 31, 750, '#FFFFFF', 'middle')}
      ${text(770, 438, 'The thread is the address. Parallel work never gets crossed.', 20, 500, '#E2E3F5', 'middle')}
    </g>
  `,
  'Copilot Teams Bridge',
  'Run more agents. Babysit fewer.',
  'No app registration. No admin consent. No tunnel.',
  true
);

const actualExtension = frame(
  `
    <g transform="translate(145 270)" filter="url(#shadow)">
      <rect width="1630" height="670" rx="28" fill="#181A1F"/>
      <rect width="1630" height="56" rx="28" fill="#2B2D30"/>
      <rect y="38" width="1630" height="18" fill="#2B2D30"/>
      ${productIcon('vscode', 24, 12, 34)}
      ${text(70, 37, 'Visual Studio Code', 18, 600, '#E5E7EB')}
      <rect x="0" y="56" width="74" height="580" fill="#24262B"/>
      <rect x="22" y="92" width="30" height="30" rx="4" fill="#8B93A7"/>
      <rect x="22" y="148" width="30" height="30" rx="15" fill="#8B93A7"/>
      <rect x="22" y="204" width="30" height="30" rx="4" fill="#8B93A7"/>
      <rect x="74" y="56" width="300" height="580" fill="#202226"/>
      ${text(100, 96, 'EXPLORER', 13, 700, '#C7CBD4')}
      ${text(100, 142, 'COPILOT-TEAMS-BRIDGE', 15, 700, '#F3F4F6')}
      ${text(122, 182, 'src', 15, 500, '#D1D5DB')}
      ${text(142, 214, 'application', 15, 500, '#B3B8C4')}
      ${text(142, 246, 'hosts', 15, 500, '#B3B8C4')}
      ${text(142, 278, 'infrastructure', 15, 500, '#B3B8C4')}
      ${text(122, 326, 'docs', 15, 500, '#D1D5DB')}
      ${text(122, 358, 'package.json', 15, 500, '#D1D5DB')}
      <rect x="374" y="56" width="1256" height="580" fill="#1E1F24"/>
      <rect x="420" y="96" width="820" height="470" rx="18" fill="#25272D" stroke="#454853"/>
      ${text(458, 140, 'Teams Bridge: Show Sessions and Threads', 22, 650, '#FFFFFF')}
      <line x1="420" y1="164" x2="1240" y2="164" stroke="#454853"/>
      <rect x="438" y="184" width="784" height="100" rx="12" fill="#373A43"/>
      <circle cx="474" cy="220" r="10" fill="${palette.amber}"/>
      ${text(500, 222, 'Add solutionArea filter', 18, 650, '#FFFFFF')}
      ${text(500, 252, 'working', 15, 500, '#B8BECA')}
      ${text(500, 273, 'key: reserve-api-filter  ·  last activity 5:18 PM', 13, 400, '#9097A6')}
      <rect x="438" y="300" width="784" height="100" rx="12" fill="#2B2D34"/>
      <circle cx="474" cy="336" r="10" fill="${palette.purple}"/>
      ${text(500, 338, 'Update onboarding docs', 18, 650, '#FFFFFF')}
      ${text(500, 368, 'needs-input', 15, 500, '#B8BECA')}
      ${text(500, 389, 'key: onboarding-docs  ·  last activity 5:12 PM', 13, 400, '#9097A6')}
      <rect x="438" y="416" width="784" height="100" rx="12" fill="#2B2D34"/>
      <circle cx="474" cy="452" r="10" fill="${palette.green}"/>
      ${text(500, 454, 'Add retry with backoff', 18, 650, '#FFFFFF')}
      ${text(500, 484, 'completed', 15, 500, '#B8BECA')}
      ${text(500, 505, 'key: retry-backoff  ·  last activity 5:05 PM', 13, 400, '#9097A6')}
      <rect x="1290" y="96" width="292" height="470" rx="18" fill="#25272D" stroke="#454853"/>
      ${productIcon('teams', 1324, 130, 58)}
      ${text(1398, 158, 'Teams Bridge', 19, 700, '#FFFFFF')}
      ${text(1324, 214, 'Actual commands', 16, 700, '#A9B4FF')}
      ${multiline(1324, 250, [
        'Set Up',
        'Start a Session',
        'Check Replies Now',
        'Show Sessions',
        'Extend a Session',
        'Show Reply Routing',
      ], 15, 40, 500, '#D1D5DB')}
      <rect x="1324" y="508" width="224" height="34" rx="17" fill="${palette.green}"/>
      ${text(1436, 531, 'Listening for replies', 13, 700, '#FFFFFF', 'middle')}
      <rect x="0" y="636" width="1630" height="34" fill="#007ACC"/>
      ${text(26, 659, '$(comment-discussion) Teams Bridge: 3 sessions', 14, 600, '#FFFFFF')}
    </g>
  `,
  'Actual extension surface',
  'What it looks like inside VS Code',
  'Real command names and the real session status model from the current code.'
);

const scenes = [
  ['01-hero', hero],
  ['02-notify', notify],
  ['03-reply-anywhere', replyAnywhere],
  ['04-resume', resume],
  ['05-parallel-sessions', closing],
  ['06-actual-extension', actualExtension],
];

for (const [name, svg] of scenes) {
  fs.writeFileSync(path.join(outDir, `${name}.svg`), svg);
  console.log(`wrote ${name}.svg`);
}
