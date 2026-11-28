import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

function showGoogleError(message: string): void {
  const errEl = document.getElementById('googleAuthError');
  if (errEl) {
    errEl.textContent = message;
    errEl.classList.remove('d-none');
  }
}

function hideGoogleError(): void {
  const errEl = document.getElementById('googleAuthError');
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('d-none');
  }
}

async function handleGoogleSignIn(btn: HTMLButtonElement): Promise<void> {
  hideGoogleError();
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML =
    '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Signing in...';

  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const cred = await signInWithPopup(auth, provider);
    const idToken = await cred.user.getIdToken(true);

    const resp = await fetch('/auth/google', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      credentials: 'same-origin',
      body: JSON.stringify({ idToken }),
    });

    const data = (await resp.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      redirect?: string;
    };

    if (!resp.ok || !data.ok) {
      showGoogleError(data.error || 'Google sign-in failed. Please try again.');
      btn.disabled = false;
      btn.innerHTML = originalHtml;
      return;
    }

    window.location.assign(data.redirect || '/');
  } catch (err: unknown) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: unknown }).code || '')
        : '';
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      hideGoogleError();
    } else {
      showGoogleError('Unable to complete Google sign-in. Please try again.');
    }
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

function initAuthBindings(): void {
  const googleBtn = document.getElementById('btnGoogleSignIn') as HTMLButtonElement | null;
  if (googleBtn) {
    googleBtn.addEventListener('click', () => {
      void handleGoogleSignIn(googleBtn);
    });
  }

  const logoutLink = document.getElementById('pvcLogoutLink') as HTMLAnchorElement | null;
  if (logoutLink) {
    logoutLink.addEventListener('click', (e) => {
      const href = logoutLink.getAttribute('href') || '/logout';
      e.preventDefault();
      void signOut(auth)
        .catch(() => undefined)
        .finally(() => {
          window.location.assign(href);
        });
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAuthBindings);
} else {
  initAuthBindings();
}
