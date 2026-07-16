import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  setDoc,
  getDocs,
  onSnapshot,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCiVF1AfxBmXeF5YvdrxbsMW-Qb2oCeb9g',
  authDomain: 'minha-saude-282ac.firebaseapp.com',
  projectId: 'minha-saude-282ac',
  storageBucket: 'minha-saude-282ac.firebasestorage.app',
  messagingSenderId: '803921904465',
  appId: '1:803921904465:web:c302569d7896ebb11bc970'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager()
    })
  });
} catch (error) {
  console.warn('Cache persistente indisponível; usando configuração padrão.', error);
  db = initializeFirestore(app);
}

const DEVICE_ID_KEY = '__minhaSaudeDeviceId';
const MIGRATION_PREFIX = '__firebaseMigrated_';
const deviceId = localStorage.getItem(DEVICE_ID_KEY) || crypto.randomUUID();
localStorage.setItem(DEVICE_ID_KEY, deviceId);

let currentUser = null;
let ready = false;
let applyingRemote = false;
let unsubscribeSnapshot = null;
let refreshTimer = null;
const pendingTimers = new Map();

const syncedExactKeys = new Set([
  'workoutHistory', 'weightLog', 'weeklyPlan', 'savedExerciseLibrary',
  'coachMemory', 'coachChatHistory', 'checkinLog', 'selectedDateKey'
]);
const syncedPrefixes = [
  'foodLog_', 'activeTreino_', 'exChecked_', 'exSeries_',
  'customExercises_', 'hiddenExercises_'
];

function shouldSyncKey(key) {
  if (!key || key.startsWith('__') || key.startsWith('firebase:')) return false;
  return syncedExactKeys.has(key) || syncedPrefixes.some(prefix => key.startsWith(prefix));
}

function safeDocId(key) {
  return encodeURIComponent(key).replaceAll('%', '_');
}

function updateStatus(status, text, type = 'amber') {
  const dot = document.getElementById('firebase-status-dot');
  const info = document.getElementById('firebase-sync-info');
  if (dot) {
    dot.textContent = status;
    dot.className = `tag tag-${type}`;
  }
  if (info && text) info.textContent = text;
}

function renderAuthUI(user) {
  const userEl = document.getElementById('firebase-user');
  const loginBtn = document.getElementById('firebase-login-btn');
  const syncBtn = document.getElementById('firebase-sync-btn');
  const logoutBtn = document.getElementById('firebase-logout-btn');

  if (user) {
    if (userEl) userEl.textContent = `${user.displayName || 'Usuário'} · ${user.email || ''}`;
    if (loginBtn) loginBtn.style.display = 'none';
    if (syncBtn) syncBtn.style.display = '';
    if (logoutBtn) logoutBtn.style.display = '';
  } else {
    if (userEl) userEl.textContent = 'Entre com sua conta Google para ativar o backup automático.';
    if (loginBtn) loginBtn.style.display = '';
    if (syncBtn) syncBtn.style.display = 'none';
    if (logoutBtn) logoutBtn.style.display = 'none';
  }
}

function getLocalEntries() {
  const entries = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!shouldSyncKey(key)) continue;
    try {
      entries.push([key, JSON.parse(localStorage.getItem(key))]);
    } catch {
      // Ignora dados locais inválidos.
    }
  }
  return entries;
}

function userDataCollection(uid) {
  return collection(db, 'users', uid, 'data');
}

async function writeKey(uid, key, value) {
  await setDoc(doc(db, 'users', uid, 'data', safeDocId(key)), {
    key,
    value,
    updatedAt: serverTimestamp(),
    updatedAtClient: new Date().toISOString(),
    deviceId
  }, { merge: true });
}

async function uploadAllLocalData(uid) {
  const entries = getLocalEntries();
  updateStatus('enviando', `Enviando ${entries.length} registros locais para a nuvem...`, 'amber');
  const batchSize = 20;
  for (let i = 0; i < entries.length; i += batchSize) {
    await Promise.all(entries.slice(i, i + batchSize).map(([key, value]) => writeKey(uid, key, value)));
  }
  localStorage.setItem(MIGRATION_PREFIX + uid, '1');
  updateStatus('sincronizado', 'Seus dados locais foram enviados e o backup automático está ativo.', 'green');
}

async function downloadCloudData(uid) {
  const snapshot = await getDocs(userDataCollection(uid));
  applyingRemote = true;
  try {
    snapshot.forEach(item => {
      const data = item.data();
      if (!data?.key || !shouldSyncKey(data.key)) return;
      localStorage.setItem(data.key, JSON.stringify(data.value));
    });
  } finally {
    applyingRemote = false;
  }
  localStorage.setItem(MIGRATION_PREFIX + uid, '1');
  window.refreshAppFromStorage?.();
  return snapshot.size;
}

async function initialSync(user) {
  updateStatus('sincronizando', 'Verificando os dados locais e a nuvem...', 'amber');
  const snapshot = await getDocs(userDataCollection(user.uid));
  const cloudCount = snapshot.size;
  const localCount = getLocalEntries().length;
  const migrated = localStorage.getItem(MIGRATION_PREFIX + user.uid) === '1';

  if (cloudCount === 0) {
    await uploadAllLocalData(user.uid);
  } else if (!migrated && localCount > 0) {
    const useCloud = window.confirm(
      `Foram encontrados ${cloudCount} registros na nuvem e ${localCount} neste aparelho.\n\n` +
      'OK: usar os dados da nuvem neste aparelho.\nCancelar: enviar os dados deste aparelho para a nuvem.'
    );
    if (useCloud) {
      await downloadCloudData(user.uid);
      updateStatus('sincronizado', `${cloudCount} registros baixados da nuvem.`, 'green');
    } else {
      await uploadAllLocalData(user.uid);
    }
  } else {
    await downloadCloudData(user.uid);
    updateStatus('sincronizado', `${cloudCount} registros sincronizados.`, 'green');
  }

  startRealtimeSync(user.uid);
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => window.refreshAppFromStorage?.(), 400);
}

function startRealtimeSync(uid) {
  unsubscribeSnapshot?.();
  unsubscribeSnapshot = onSnapshot(userDataCollection(uid), snapshot => {
    if (!ready) return;
    let changed = false;
    applyingRemote = true;
    try {
      snapshot.docChanges().forEach(change => {
        if (change.type === 'removed') return;
        const data = change.doc.data();
        if (!data?.key || data.deviceId === deviceId || !shouldSyncKey(data.key)) return;
        localStorage.setItem(data.key, JSON.stringify(data.value));
        changed = true;
      });
    } finally {
      applyingRemote = false;
    }
    if (changed) {
      updateStatus('atualizado', 'Alterações de outro dispositivo foram recebidas.', 'green');
      scheduleRefresh();
    }
  }, error => {
    console.error('Erro na sincronização em tempo real:', error);
    updateStatus('offline', 'Sem conexão com a nuvem. Os dados continuam salvos neste aparelho.', 'amber');
  });
}

window.firebaseSave = function firebaseSave(key, value) {
  if (applyingRemote || !ready || !currentUser || !shouldSyncKey(key)) return;
  clearTimeout(pendingTimers.get(key));
  const timer = setTimeout(async () => {
    try {
      updateStatus('salvando', 'Salvando alterações na nuvem...', 'amber');
      await writeKey(currentUser.uid, key, value);
      updateStatus('sincronizado', `Última sincronização: ${new Date().toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'})}`, 'green');
    } catch (error) {
      console.error('Erro ao salvar no Firebase:', error);
      updateStatus('offline', 'Não foi possível salvar na nuvem agora. O dado permanece no aparelho.', 'amber');
    }
  }, 700);
  pendingTimers.set(key, timer);
};

window.firebaseLogin = async function firebaseLogin() {
  try {
    updateStatus('entrando', 'Abrindo o login do Google...', 'amber');
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.matchMedia('(display-mode: standalone)').matches;
    if (isMobile) await signInWithRedirect(auth, provider);
    else await signInWithPopup(auth, provider);
  } catch (error) {
    console.error(error);
    updateStatus('erro', friendlyAuthError(error), 'red');
  }
};

window.firebaseLogout = async function firebaseLogout() {
  await signOut(auth);
};

window.firebaseSyncNow = async function firebaseSyncNow() {
  if (!currentUser) return window.firebaseLogin();
  try {
    await uploadAllLocalData(currentUser.uid);
    window.showToast?.('☁️ Sincronização concluída!');
  } catch (error) {
    console.error(error);
    updateStatus('erro', 'Falha ao sincronizar. Confira a conexão e as regras do Firestore.', 'red');
  }
};

function friendlyAuthError(error) {
  const code = error?.code || '';
  if (code.includes('unauthorized-domain')) return 'Domínio não autorizado. Adicione joaovitormoreno21.github.io no Firebase Authentication.';
  if (code.includes('popup-blocked')) return 'O navegador bloqueou o login. Tente novamente.';
  if (code.includes('popup-closed')) return 'Login cancelado.';
  return error?.message || 'Não foi possível entrar com o Google.';
}

window.addEventListener('online', () => {
  if (currentUser) window.firebaseSyncNow();
});
window.addEventListener('offline', () => {
  updateStatus('offline', 'Você está offline. Tudo continuará salvo neste aparelho.', 'amber');
});

document.addEventListener('DOMContentLoaded', () => {
  renderAuthUI(null);
  updateStatus('iniciando', 'Conectando ao Firebase...', 'amber');
});

try {
  await getRedirectResult(auth);
} catch (error) {
  console.error('Erro ao concluir redirecionamento:', error);
  updateStatus('erro', friendlyAuthError(error), 'red');
}

onAuthStateChanged(auth, async user => {
  currentUser = user;
  ready = false;
  renderAuthUI(user);

  if (!user) {
    unsubscribeSnapshot?.();
    unsubscribeSnapshot = null;
    updateStatus('somente local', 'Os dados estão salvos neste aparelho. Entre com Google para ativar a nuvem.', 'amber');
    return;
  }

  try {
    await initialSync(user);
    ready = true;
    updateStatus('sincronizado', 'Backup automático ativo e dados atualizados.', 'green');
  } catch (error) {
    console.error('Erro na sincronização inicial:', error);
    updateStatus('erro', 'Login realizado, mas a sincronização falhou. Verifique as regras do Firestore.', 'red');
  }
});
