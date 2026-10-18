'use strict';

/*
 * The footer on the closet and privacy pages: who built Fitting Room and where to find it.
 * Add each teammate to TEAM as { name, linkedin } and they show up on every page.
 */
(function () {
  const REPO = 'https://github.com/Nathan-123/dubhacks2026project';
  const TEAM = [];

  const GITHUB = '<path d="M12 .5a11.5 11.5 0 00-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 015.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.7 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0012 .5z"/>';
  const LINKEDIN = '<path d="M20.45 20.45h-3.56v-5.57c0-1.33-.03-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 110-4.13 2.06 2.06 0 010 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z"/>';
  const icon = (path) => `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="currentColor">${path}</svg>`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  const team = TEAM.map((t) => t.linkedin
    ? `<a class="person" href="${esc(t.linkedin)}" target="_blank" rel="noopener noreferrer">${icon(LINKEDIN)}${esc(t.name)}</a>`
    : `<span class="person">${esc(t.name)}</span>`).join('');

  document.getElementById('site-footer').innerHTML = `<div class="footer-row">
      <span class="made">Built at DubHacks ’26</span>
      <nav class="footer-links" aria-label="About Fitting Room">
        <a href="../privacy/privacy.html">Privacy</a>
        <a href="${REPO}" target="_blank" rel="noopener noreferrer">${icon(GITHUB)}GitHub</a>
      </nav>
    </div>
    ${team ? `<div class="footer-team" aria-label="Made by">${team}</div>` : ''}`;
})();
