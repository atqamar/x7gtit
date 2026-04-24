(function initDecrypt() {
  var SESSION_KEY = '_d';
  var LOCAL_PW_KEY = '_p';
  var OVERLAY_HOSTED_KEY = '_o';

  window.__HOSTED_OVERLAY_KEY__ = OVERLAY_HOSTED_KEY;

  function applyLabels(data) {
    var labels = (data && data.labels) || null;
    if (!labels) return;
    if (labels.title) document.title = labels.title;
    if (labels.brand_html) {
      document.querySelectorAll('.site-nav-brand').forEach(function (el) {
        el.innerHTML = labels.brand_html;
      });
    }
    var navMap = labels.nav_links || {};
    document.querySelectorAll('#site-nav a.site-nav-link').forEach(function (a) {
      var href = a.getAttribute('href') || '';
      if (/index\.html(\?|#|$)/.test(href) && navMap.index) a.textContent = navMap.index;
      else if (/docs\.html(\?|#|$)/.test(href) && navMap.docs) a.textContent = navMap.docs;
      else if (/references\.html(\?|#|$)/.test(href) && navMap.references) a.textContent = navMap.references;
    });
    var h1 = document.querySelector('#header h1');
    if (h1 && labels.header_h1) h1.textContent = labels.header_h1;
    var sortLabel = document.querySelector('label[for="sort-select"]');
    if (sortLabel && labels.sort_label) sortLabel.textContent = labels.sort_label;
    var filterLabel = document.querySelector('label[for="category-filter"]');
    if (filterLabel && labels.filter_label) filterLabel.textContent = labels.filter_label;
    if (labels.sort_options) {
      document.querySelectorAll('#sort-select option').forEach(function (opt) {
        if (labels.sort_options[opt.value]) opt.textContent = labels.sort_options[opt.value];
      });
    }
    if (labels.column_tooltips) {
      document.querySelectorAll('#projects-table thead th[data-col]').forEach(function (th) {
        var col = th.getAttribute('data-col');
        var pair = labels.column_tooltips[col];
        if (pair) {
          th.textContent = pair[0] || th.textContent;
          if (pair[1]) th.setAttribute('title', pair[1]);
        }
      });
    }
    if (labels.sidebar_tabs) {
      document.querySelectorAll('.sidebar-tab[data-tab]').forEach(function (btn) {
        var t = btn.getAttribute('data-tab');
        if (labels.sidebar_tabs[t]) btn.textContent = labels.sidebar_tabs[t];
      });
    }
    var docsSectionTitle = document.getElementById('docs-section-title');
    if (docsSectionTitle && labels.docs_section_title) {
      docsSectionTitle.textContent = labels.docs_section_title;
    }
    var crumbSec = document.getElementById('docs-breadcrumb-section');
    if (crumbSec && labels.docs_breadcrumb_default && !crumbSec.textContent.replace(/\s/g,'')) {
      crumbSec.textContent = labels.docs_breadcrumb_default;
    }
    var refsHeaderH1 = document.querySelector('#refs-header h1');
    if (refsHeaderH1 && labels.refs_h1) refsHeaderH1.textContent = labels.refs_h1;
  }

  function applyLabelsWhenReady(data) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { applyLabels(data); });
    } else {
      applyLabels(data);
    }
  }

  window.__applyLabels__ = applyLabels;

  // Fast path: data already in sessionStorage (page navigation within tab)
  try {
    var cached = sessionStorage.getItem(SESSION_KEY);
    if (cached) {
      window.__DECRYPTED_DATA__ = JSON.parse(cached);
      applyLabelsWhenReady(window.__DECRYPTED_DATA__);
      return;
    }
  } catch (_) {}

  // ------------------------------------------------------------------
  // Build and inject overlay immediately (before DOMContentLoaded)
  // so there is no flash of unprotected content.
  // ------------------------------------------------------------------
  var overlay = document.createElement('div');
  overlay.id = 'pw-overlay';
  overlay.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'width:100%', 'height:100%',
    'background:#f0f2f5', 'display:flex', 'align-items:center',
    'justify-content:center', 'z-index:9999',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
  ].join(';');

  overlay.innerHTML = [
    '<div id="pw-box" style="background:#fff;border-radius:8px;padding:32px 36px;',
    'box-shadow:0 4px 24px rgba(0,0,0,0.12);max-width:380px;width:100%;box-sizing:border-box;">',
    '<h2 style="margin:0 0 8px;font-size:1.25rem;color:#1a1a1a;">Snapshot</h2>',
    '<p style="margin:0 0 16px;font-size:0.9rem;color:#555;">',
    'Enter password.</p>',
    '<form id="pw-form" autocomplete="off">',
    '<input type="password" id="pw-input" placeholder="Password" autofocus ',
    'style="width:100%;padding:8px;font-size:1rem;box-sizing:border-box;',
    'border:1px solid #ccc;border-radius:4px;" />',
    '<div id="pw-error" style="color:#c0392b;margin:6px 0;min-height:1.2em;',
    'font-size:0.85rem;"></div>',
    '<button type="submit" id="pw-submit" ',
    'style="width:100%;padding:8px;font-size:1rem;cursor:pointer;',
    'margin-top:4px;background:#1a1a1a;color:#fff;border:none;border-radius:4px;">',
    'Unlock</button>',
    '</form>',
    '<p id="pw-working" style="display:none;color:#555;font-size:0.9rem;',
    'margin-top:12px;text-align:center;">Decrypting&hellip;</p>',
    '</div>',
  ].join('');

  document.documentElement.appendChild(overlay);

  // ------------------------------------------------------------------
  // Core crypto helpers
  // ------------------------------------------------------------------
  function b64ToBytes(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  async function fetchAndDecrypt(password) {
    var resp = await fetch('./data.enc.json');
    if (!resp.ok) throw new Error('Failed to fetch data.enc.json: ' + resp.status);
    var envelope = await resp.json();

    if (envelope.v !== 1) throw new Error('Unknown envelope version: ' + envelope.v);

    var enc = new TextEncoder();
    var passwordKey = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
    );
    var salt = b64ToBytes(envelope.kdf.salt_b64);
    var keyBits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: envelope.kdf.iterations },
      passwordKey,
      512  // 64 bytes
    );
    var encKeyBytes = keyBits.slice(0, 32);
    var macKeyBytes = keyBits.slice(32, 64);

    // Verify HMAC-SHA256 first (authenticate before decrypt)
    var macKey = await crypto.subtle.importKey(
      'raw', macKeyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    var iv = b64ToBytes(envelope.cipher.iv_b64);
    var ciphertext = b64ToBytes(envelope.ciphertext_b64);
    var mac = b64ToBytes(envelope.mac_b64);

    // MAC input: salt || iv || ciphertext
    var saltArr = new Uint8Array(salt);
    var ivArr = new Uint8Array(iv);
    var ctArr = new Uint8Array(ciphertext);
    var macInput = new Uint8Array(saltArr.byteLength + ivArr.byteLength + ctArr.byteLength);
    macInput.set(saltArr, 0);
    macInput.set(ivArr, saltArr.byteLength);
    macInput.set(ctArr, saltArr.byteLength + ivArr.byteLength);

    var valid = await crypto.subtle.verify('HMAC', macKey, mac, macInput);
    if (!valid) throw new Error('MAC verification failed — wrong password or tampered data');

    // Decrypt AES-256-CTR
    var encKey = await crypto.subtle.importKey(
      'raw', encKeyBytes, { name: 'AES-CTR' }, false, ['decrypt']
    );
    var plaintextBuf = await crypto.subtle.decrypt(
      { name: 'AES-CTR', counter: iv, length: 128 },
      encKey,
      ciphertext
    );
    return JSON.parse(new TextDecoder().decode(plaintextBuf));
  }

  // ------------------------------------------------------------------
  // After successful decryption: cache + signal
  // ------------------------------------------------------------------
  function onDecryptSuccess(data, password) {
    window.__DECRYPTED_DATA__ = data;
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(data)); } catch (_) {}
    try { localStorage.setItem(LOCAL_PW_KEY, password); } catch (_) {}
    applyLabels(data);
    overlay.remove();
    document.dispatchEvent(new CustomEvent('data-decrypted'));
  }

  // ------------------------------------------------------------------
  // Show the working indicator (auto-decrypt path)
  // ------------------------------------------------------------------
  function showWorking() {
    var formEl = document.getElementById('pw-form');
    var workingEl = document.getElementById('pw-working');
    if (formEl) formEl.style.display = 'none';
    if (workingEl) workingEl.style.display = 'block';
  }

  // ------------------------------------------------------------------
  // Show an error and reset the form
  // ------------------------------------------------------------------
  function showError(msg) {
    var formEl = document.getElementById('pw-form');
    var workingEl = document.getElementById('pw-working');
    var errorEl = document.getElementById('pw-error');
    var submitBtn = document.getElementById('pw-submit');
    var inputEl = document.getElementById('pw-input');
    if (formEl) formEl.style.display = '';
    if (workingEl) workingEl.style.display = 'none';
    if (errorEl) errorEl.textContent = msg;
    if (submitBtn) submitBtn.disabled = false;
    if (inputEl) { inputEl.value = ''; inputEl.focus(); }
  }

  // ------------------------------------------------------------------
  // Wire up the form submit handler after DOM is ready
  // ------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    // Move overlay into body now that it exists.
    document.body.appendChild(overlay);

    var form = document.getElementById('pw-form');
    var submitBtn = document.getElementById('pw-submit');
    var errorEl = document.getElementById('pw-error');
    var workingEl = document.getElementById('pw-working');
    var inputEl = document.getElementById('pw-input');

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      errorEl.textContent = '';
      workingEl.style.display = 'block';
      submitBtn.disabled = true;

      var password = inputEl.value;
      try {
        var data = await fetchAndDecrypt(password);
        onDecryptSuccess(data, password);
      } catch (err) {
        console.error('Decryption error:', err);
        showError('Wrong password or corrupted data.');
      }
    });

    // ------------------------------------------------------------------
    // Auto-decrypt: if a saved password exists in localStorage, try it.
    // ------------------------------------------------------------------
    var savedPw = null;
    try { savedPw = localStorage.getItem(LOCAL_PW_KEY); } catch (_) {}

    if (savedPw) {
      showWorking();
      fetchAndDecrypt(savedPw).then(function (data) {
        onDecryptSuccess(data, savedPw);
      }).catch(function (err) {
        console.warn('Auto-decrypt failed (password changed?), clearing saved password:', err);
        try { localStorage.removeItem(LOCAL_PW_KEY); } catch (_) {}
        // Re-show the form so the user can enter the new password.
        var formEl = document.getElementById('pw-form');
        var workingEl2 = document.getElementById('pw-working');
        if (formEl) formEl.style.display = '';
        if (workingEl2) workingEl2.style.display = 'none';
        var errorEl2 = document.getElementById('pw-error');
        if (errorEl2) errorEl2.textContent = 'Saved password no longer valid — please enter the new password.';
        var submitBtn2 = document.getElementById('pw-submit');
        if (submitBtn2) submitBtn2.disabled = false;
        var inputEl2 = document.getElementById('pw-input');
        if (inputEl2) inputEl2.focus();
      });
    }
  });
})();
