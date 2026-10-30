/**
 * Calques de la vidéo, au-dessus de l'application : sous-titre, cadre de surlignage, pointeur de souris (Playwright
 * n'enregistre pas le curseur) et cartes de titre. Pilotés depuis `scenes.mjs` par `window.__video`.
 */
(() => {
  const css = `
    #vid-layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    #vid-caption {
      position: absolute; left: 50%; bottom: 34px; transform: translate(-50%, 12px); max-width: 1180px;
      padding: 14px 26px; border-radius: 14px; background: rgba(10, 14, 22, 0.86); color: #f5f7fb;
      font-size: 25px; line-height: 1.38; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,.35);
      border: 1px solid rgba(255,255,255,.08); opacity: 0; transition: opacity .35s ease, transform .35s ease;
    }
    #vid-caption.show { opacity: 1; transform: translate(-50%, 0); }
    #vid-caption b { color: #fbbf24; font-weight: 650; }
    #vid-highlight {
      position: absolute; border: 3px solid #fbbf24; border-radius: 16px; opacity: 0;
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.38), 0 0 26px rgba(251, 191, 36, .55);
      transition: all .55s cubic-bezier(.2,.8,.2,1);
    }
    #vid-highlight.show { opacity: 1; }
    #vid-cursor {
      position: absolute; left: 0; top: 0; width: 26px; height: 26px; margin: -3px 0 0 -3px; opacity: 0;
      transition: opacity .3s; filter: drop-shadow(0 2px 3px rgba(0,0,0,.5));
    }
    #vid-cursor.show { opacity: 1; }
    #vid-cursor.down svg { transform: scale(.85); }
    #vid-cursor svg { transition: transform .12s; transform-origin: 3px 3px; }
    #vid-card {
      position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 18px; background: radial-gradient(circle at 50% 40%, #1d2a44 0%, #0b1020 70%); color: #fff; opacity: 0;
      transition: opacity .7s ease;
    }
    #vid-card.show { opacity: 1; }
    #vid-card .logo { width: 104px; height: 104px; border-radius: 28px; display: grid; place-items: center;
      background: linear-gradient(135deg, #fbbf24, #f59e0b); box-shadow: 0 12px 50px rgba(251,191,36,.35); }
    #vid-card h1 { margin: 6px 0 0; font-size: 74px; letter-spacing: -1.5px; font-weight: 750; }
    #vid-card p { margin: 0; font-size: 28px; color: #b8c3d9; }
  `;

  function mount() {
    if (document.getElementById('vid-layer')) return;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const layer = document.createElement('div');
    layer.id = 'vid-layer';
    layer.innerHTML = `
      <div id="vid-highlight"></div>
      <div id="vid-caption"></div>
      <div id="vid-card"></div>
      <div id="vid-cursor"><svg width="26" height="26" viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.9L21 10.5z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg></div>`;
    document.body.appendChild(layer);
    const cursor = layer.querySelector('#vid-cursor');
    window.addEventListener(
      'mousemove',
      (e) => {
        cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      },
      true,
    );
    window.addEventListener('mousedown', () => cursor.classList.add('down'), true);
    window.addEventListener('mouseup', () => cursor.classList.remove('down'), true);
  }

  const $ = (id) => document.getElementById(id);

  let tracked = null;
  function place() {
    const box = $('vid-highlight');
    const els = tracked ? [...document.querySelectorAll(tracked.selector)] : [];
    const rects = els.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
    if (rects.length === 0) {
      box.classList.remove('show');
      return false;
    }
    const { pad } = tracked;
    const left = Math.min(...rects.map((r) => r.left)) - pad;
    const top = Math.min(...rects.map((r) => r.top)) - pad;
    const right = Math.max(...rects.map((r) => r.right)) + pad;
    const bottom = Math.max(...rects.map((r) => r.bottom)) + pad;
    Object.assign(box.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${right - left}px`,
      height: `${bottom - top}px`,
    });
    box.classList.add('show');
    return true;
  }
  const follow = () => {
    if (tracked && document.getElementById('vid-layer')) place();
    requestAnimationFrame(follow);
  };
  requestAnimationFrame(follow);

  window.__video = {
    caption(html) {
      mount();
      const el = $('vid-caption');
      if (!html) {
        el.classList.remove('show');
        return;
      }
      el.innerHTML = html;
      el.classList.add('show');
    },
    /** Encadre les éléments du sélecteur (leur enveloppe commune) et suit leur position quand la page défile. */
    highlight(selector, pad = 8) {
      mount();
      tracked = selector ? { selector, pad } : null;
      return place();
    },
    cursor(show) {
      mount();
      $('vid-cursor').classList.toggle('show', show);
    },
    card(title, subtitle) {
      mount();
      const card = $('vid-card');
      if (!title) {
        card.classList.remove('show');
        return;
      }
      card.innerHTML = `
        <div class="logo"><svg width="58" height="58" viewBox="0 0 24 24" fill="#0b1020"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg></div>
        <h1>${title}</h1><p>${subtitle ?? ''}</p>`;
      card.classList.add('show');
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
