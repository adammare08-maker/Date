/* ===========================================================
   Dette — application en ligne (Supabase)
   Les offres, demandes et photos sont partagées entre tous
   les utilisateurs. Le RLS côté base garantit que chacun ne
   voit et ne modifie que ce qui le concerne.
   =========================================================== */

const sb = window.supabase.createClient(DETTE_CONFIG.url, DETTE_CONFIG.key);

let user = null;            // { id, name }
let map = null;
let markersLayer = null;
let pickedLocation = null;
let createPhotoData = null; // dataURL de la photo prise/choisie
let currentOfferId = null;
let offersCache = [];
let realtimeChannel = null;

let cameraStream = null;
let cameraFacingMode = 'user';
let cameraCallback = null;
let cameraFallbackInput = null;

/* ---------------------------------------------------------
   Utilitaires
   --------------------------------------------------------- */

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s == null ? '' : s;
  return div.innerHTML;
}

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.nav === name);
  });
  if (name === 'map') setTimeout(() => map && map.invalidateSize(), 50);
}

function setBusy(btn, busy, busyLabel) {
  if (!btn) return;
  if (busy) {
    btn.dataset.label = btn.dataset.label || btn.textContent;
    btn.textContent = busyLabel || 'Un instant...';
    btn.disabled = true;
  } else {
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
    btn.disabled = false;
  }
}

// Traduit les erreurs Supabase en messages compréhensibles.
function humanError(error) {
  const msg = (error && (error.message || error.msg)) || '';
  if (/provider is not enabled|Unsupported provider|validation_failed/i.test(msg)) {
    return "La connexion Google n'est pas encore activée sur le projet Supabase. " +
           "Tableau de bord Supabase → Authentication → Sign In / Providers → Google : " +
           "active la section, colle le Client ID et le Client Secret, puis enregistre.";
  }
  if (/anonymous.*disabled|anonymous_provider_disabled/i.test(msg)) {
    return "Les connexions anonymes ne sont pas activées sur le projet Supabase.";
  }
  if (/Failed to fetch|NetworkError/i.test(msg)) {
    return "Impossible de joindre le serveur. Vérifie ta connexion internet.";
  }
  if (/duplicate key|already exists/i.test(msg)) {
    return "Tu as déjà envoyé une demande pour cette offre.";
  }
  if (/row-level security|violates row-level/i.test(msg)) {
    return "Action non autorisée.";
  }
  return msg || "Une erreur est survenue.";
}

/* ---------------------------------------------------------
   Photos : compression puis envoi vers Supabase Storage
   --------------------------------------------------------- */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image illisible."));
    img.src = src;
  });
}

// Réduit la photo (max 900 px) et la convertit en JPEG léger.
async function compressToBlob(dataUrl, maxSize = 900, quality = 0.82) {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
  if (!blob) throw new Error("Conversion de la photo impossible.");
  return blob;
}

async function uploadPhoto(dataUrl) {
  const blob = await compressToBlob(dataUrl);
  const path = user.id + '/' + crypto.randomUUID() + '.jpg';
  const { error } = await sb.storage
    .from('photos')
    .upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;
  return sb.storage.from('photos').getPublicUrl(path).data.publicUrl;
}

/* ---------------------------------------------------------
   Authentification
   --------------------------------------------------------- */

// Redirige vers Google. Au retour, supabase-js lit la session dans l'URL.
async function signInWithGoogle() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
  if (error) throw error;
}

// Assemble l'identité affichable à partir du compte d'authentification.
function buildUser(authUser, name) {
  const meta = authUser.user_metadata || {};
  const app = authUser.app_metadata || {};
  return {
    id: authUser.id,
    name,
    email: authUser.email || meta.email || '',
    avatar: meta.avatar_url || meta.picture || '',
    provider: app.provider || 'email',
  };
}

// Enregistre prénom + date de naissance pour l'utilisateur déjà connecté.
async function saveProfile(authUser, name, birthdate) {
  const { error } = await sb
    .from('profiles')
    .upsert({ id: authUser.id, name, birthdate }, { onConflict: 'id' });
  if (error) throw error;
  user = buildUser(authUser, name);
}

// État de la session : 'deconnecte' | 'profil-manquant' | 'pret'
async function inspectSession() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return { etat: 'deconnecte' };

  const authUser = data.session.user;
  const { data: profile } = await sb
    .from('profiles')
    .select('name')
    .eq('id', authUser.id)
    .maybeSingle();

  if (profile && profile.name) {
    user = buildUser(authUser, profile.name);
    return { etat: 'pret' };
  }
  return { etat: 'profil-manquant', authUser };
}

/* ---------------------------------------------------------
   Puce d'identité (barre supérieure)
   --------------------------------------------------------- */

const NOMS_PROVIDER = { google: 'Google', email: 'E-mail', anonymous: 'Compte invité' };

function renderIdentity() {
  if (!user) return;
  const initiale = (user.name || '?').trim().charAt(0).toUpperCase();

  // Avatar : photo Google si disponible, sinon initiale sur fond dégradé.
  [['profile-avatar', 'profile-initial'], ['panel-avatar', 'panel-initial']].forEach(([idImg, idIni]) => {
    const img = document.getElementById(idImg);
    const ini = document.getElementById(idIni);
    if (user.avatar) {
      img.src = user.avatar;
      img.style.display = 'block';
      ini.style.display = 'none';
      img.onerror = () => { img.style.display = 'none'; ini.style.display = 'flex'; };
    } else {
      img.style.display = 'none';
      ini.style.display = 'flex';
    }
    ini.textContent = initiale;
  });

  document.getElementById('profile-firstname').textContent = user.name;
  document.getElementById('panel-name').textContent = user.name;

  const email = document.getElementById('panel-email');
  email.textContent = user.email || 'Aucune adresse associée';
  email.title = user.email || '';

  document.getElementById('panel-provider').textContent =
    'Connecté via ' + (NOMS_PROVIDER[user.provider] || user.provider);
}

function toggleProfilePanel(force) {
  const panel = document.getElementById('profile-panel');
  const bouton = document.getElementById('btn-profile');
  const ouvrir = force !== undefined ? force : panel.style.display === 'none';
  panel.style.display = ouvrir ? 'block' : 'none';
  bouton.setAttribute('aria-expanded', String(ouvrir));
}

document.getElementById('btn-profile').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleProfilePanel();
});

// Fermeture au clic extérieur ou sur Échap
document.addEventListener('click', (e) => {
  const panel = document.getElementById('profile-panel');
  if (panel.style.display !== 'none' && !panel.contains(e.target)) toggleProfilePanel(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') toggleProfilePanel(false);
});

// Affiche l'étape « finalise ton profil », prénom pré-rempli depuis Google.
function showProfileStep(authUser) {
  document.getElementById('landing-signin').style.display = 'none';
  document.getElementById('landing-form').style.display = 'flex';

  const meta = authUser.user_metadata || {};
  const propose = meta.given_name || meta.name || meta.full_name || '';
  const champ = document.getElementById('landing-name');
  if (propose && !champ.value) champ.value = String(propose).trim().split(/\s+/)[0];
}

function showSignInStep() {
  document.getElementById('landing-signin').style.display = 'flex';
  document.getElementById('landing-form').style.display = 'none';
}

/* ---------------------------------------------------------
   Accès aux données
   --------------------------------------------------------- */

async function fetchOffers() {
  const { data, error } = await sb
    .from('offers')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  if (error) { console.error(error); return offersCache; }
  offersCache = data || [];
  return offersCache;
}

function cachedOffer(id) {
  return offersCache.find(o => o.id === id) || null;
}

async function createOffer({ placeName, lat, lng, photoUrl, message }) {
  const { error } = await sb.from('offers').insert({
    user_id: user.id,
    user_name: user.name,
    place_name: placeName,
    lat, lng,
    photo_url: photoUrl,
    message,
  });
  if (error) throw error;
}

// Extrait le chemin de stockage depuis l'URL publique d'une photo.
function storagePathFromUrl(url) {
  const marqueur = '/storage/v1/object/public/photos/';
  const i = (url || '').indexOf(marqueur);
  if (i === -1) return null;
  return decodeURIComponent(url.slice(i + marqueur.length).split('?')[0]);
}

// Supprime une offre. Les demandes liées partent en cascade (contrainte SQL).
async function deleteOffer(offer) {
  const { error } = await sb.from('offers').delete().eq('id', offer.id);
  if (error) throw error;

  // Nettoyage de la photo : sans importance si ça échoue, l'offre est déjà partie.
  const chemin = storagePathFromUrl(offer.photo_url);
  if (chemin) {
    const { error: errPhoto } = await sb.storage.from('photos').remove([chemin]);
    if (errPhoto) console.warn('Photo non supprimée :', errPhoto.message);
  }
}

async function createRequest({ offerId, name, photoUrl, message }) {
  const { error } = await sb.from('requests').insert({
    offer_id: offerId,
    requester_id: user.id,
    requester_name: name,
    photo_url: photoUrl,
    message,
  });
  if (error) throw error;
}

async function fetchReceivedRequests() {
  const { data, error } = await sb
    .from('requests')
    .select('*, offer:offers!inner(id, user_id, user_name, place_name, photo_url)')
    .eq('offer.user_id', user.id)
    .order('created_at', { ascending: false });
  if (error) { console.error(error); return []; }
  return data || [];
}

async function fetchSentRequests() {
  const { data, error } = await sb
    .from('requests')
    .select('*, offer:offers(id, user_name, place_name, photo_url)')
    .eq('requester_id', user.id)
    .order('created_at', { ascending: false });
  if (error) { console.error(error); return []; }
  return data || [];
}

async function setRequestStatus(id, status) {
  const { error } = await sb.from('requests').update({ status }).eq('id', id);
  if (error) throw error;
}

async function hasAlreadyRequested(offerId) {
  const { data } = await sb
    .from('requests')
    .select('id')
    .eq('offer_id', offerId)
    .eq('requester_id', user.id)
    .maybeSingle();
  return !!data;
}

/* ---------------------------------------------------------
   Carte
   --------------------------------------------------------- */

function pinIcon(emoji) {
  return L.divIcon({
    html: '<div style="font-size:28px;line-height:1;transform:translateY(-8px)">' + emoji + '</div>',
    className: '', iconSize: [28, 28], iconAnchor: [14, 28]
  });
}

function initMap() {
  map = L.map('leaflet-map').setView([48.8566, 2.3522], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);

  map.on('click', (e) => {
    pickedLocation = { lat: e.latlng.lat, lng: e.latlng.lng };
    openCreateSheet();
  });

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 14),
      () => {}
    );
  }
}

function drawMarkers() {
  if (!markersLayer) return;
  markersLayer.clearLayers();
  offersCache.forEach(o => {
    const isMine = o.user_id === user.id;
    const m = L.marker([o.lat, o.lng], { icon: pinIcon(isMine ? '💛' : '❤️') });
    m.on('click', () => { currentOfferId = o.id; renderOfferView(); showView('offer'); });
    m.bindPopup(escapeHtml(o.place_name || 'Un lieu'));
    m.addTo(markersLayer);
  });
}

async function refreshMarkers() {
  await fetchOffers();
  drawMarkers();
}

/* ---------------------------------------------------------
   Temps réel : la carte et les demandes se mettent à jour seules
   --------------------------------------------------------- */

function startRealtime() {
  if (realtimeChannel) return;
  realtimeChannel = sb
    .channel('dette-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'offers' }, () => {
      refreshMarkers();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'requests' }, () => {
      if (document.getElementById('view-inbox').classList.contains('active')) renderInbox();
    })
    .subscribe();
}

function stopRealtime() {
  if (realtimeChannel) { sb.removeChannel(realtimeChannel); realtimeChannel = null; }
}

/* ---------------------------------------------------------
   Feuille « proposer une dette »
   --------------------------------------------------------- */

function openCreateSheet() {
  document.getElementById('sheet-overlay').classList.add('active');
}

function closeCreateSheet() {
  document.getElementById('sheet-overlay').classList.remove('active');
  document.getElementById('create-form').reset();
  document.getElementById('create-preview').style.display = 'none';
  createPhotoData = null;
  document.getElementById('create-submit').disabled = true;
  pickedLocation = null;
}

document.getElementById('create-cancel').addEventListener('click', closeCreateSheet);
document.getElementById('sheet-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'sheet-overlay') closeCreateSheet();
});

function checkCreateValid() {
  const msg = document.getElementById('create-message').value.trim();
  document.getElementById('create-submit').disabled = !(createPhotoData && msg);
}
document.getElementById('create-message').addEventListener('input', checkCreateValid);

document.getElementById('create-camera-btn').addEventListener('click', () => {
  cameraFallbackInput = document.getElementById('create-photo-fallback');
  openCamera((dataUrl) => {
    createPhotoData = dataUrl;
    const img = document.getElementById('create-preview');
    img.src = dataUrl;
    img.style.display = 'block';
    checkCreateValid();
  });
});

document.getElementById('create-photo-fallback').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    createPhotoData = reader.result;
    const img = document.getElementById('create-preview');
    img.src = createPhotoData;
    img.style.display = 'block';
    checkCreateValid();
  };
  reader.readAsDataURL(file);
});

document.getElementById('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = document.getElementById('create-submit');
  const place = document.getElementById('create-place').value.trim() || 'Lieu choisi';
  const message = document.getElementById('create-message').value.trim();
  if (!createPhotoData || !message || !pickedLocation) return;

  setBusy(submitBtn, true, 'Publication...');
  try {
    const photoUrl = await uploadPhoto(createPhotoData);
    await createOffer({
      placeName: place,
      lat: pickedLocation.lat,
      lng: pickedLocation.lng,
      photoUrl,
      message,
    });
    closeCreateSheet();
    await refreshMarkers();
  } catch (err) {
    alert(humanError(err));
  } finally {
    setBusy(submitBtn, false);
  }
});

/* ---------------------------------------------------------
   Caméra
   --------------------------------------------------------- */

function openCamera(callback) {
  cameraCallback = callback;
  document.getElementById('camera-overlay').classList.add('active');
  startCameraStream();
}

async function startCameraStream() {
  stopCameraStream();
  document.getElementById('camera-hint').textContent =
    'Cadre ton visage puis appuie sur le bouton pour te prendre en photo.';

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    closeCamera();
    if (cameraFallbackInput) cameraFallbackInput.click();
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: cameraFacingMode }, audio: false
    });
    const video = document.getElementById('camera-video');
    video.srcObject = cameraStream;
    video.style.transform = cameraFacingMode === 'user' ? 'scaleX(-1)' : 'scaleX(1)';
  } catch (err) {
    closeCamera();
    alert("Impossible d'accéder à la caméra (permission refusée ou aucune caméra détectée). Choisis une photo depuis ta galerie.");
    if (cameraFallbackInput) cameraFallbackInput.click();
  }
}

function stopCameraStream() {
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
}

function closeCamera() {
  stopCameraStream();
  document.getElementById('camera-overlay').classList.remove('active');
}

document.getElementById('camera-cancel').addEventListener('click', closeCamera);
document.getElementById('camera-switch').addEventListener('click', () => {
  cameraFacingMode = cameraFacingMode === 'user' ? 'environment' : 'user';
  startCameraStream();
});
document.getElementById('camera-shutter').addEventListener('click', () => {
  const video = document.getElementById('camera-video');
  const canvas = document.getElementById('camera-canvas');
  canvas.width = video.videoWidth || 720;
  canvas.height = video.videoHeight || 960;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  closeCamera();
  if (cameraCallback) cameraCallback(dataUrl);
});

/* ---------------------------------------------------------
   Vue « offre »
   --------------------------------------------------------- */

async function renderOfferView() {
  const offer = cachedOffer(currentOfferId);
  const detail = document.getElementById('offer-detail');
  const action = document.getElementById('offer-action');

  if (!offer) {
    detail.innerHTML = '<p>Offre introuvable.</p>';
    action.innerHTML = '';
    return;
  }

  detail.innerHTML =
    '<div class="profile-card">' +
      '<div class="msg-bubble">' + escapeHtml(offer.message) + '</div>' +
      '<div class="profile-photo-wrap">' +
        '<img src="' + escapeHtml(offer.photo_url) + '" class="profile-photo" alt="" />' +
        '<div class="profile-badge" title="' + escapeHtml(offer.place_name) + '">📍</div>' +
      '</div>' +
      '<p class="profile-name">' + escapeHtml(offer.user_name) + '</p>' +
    '</div>';

  if (offer.user_id === user.id) {
    action.innerHTML =
      '<p class="hint">C\'est ta propre offre. Retrouve les demandes reçues dans l\'onglet « Demandes ».</p>' +
      '<button type="button" id="delete-offer-btn" class="btn-danger w-full">🗑️ Supprimer cette dette</button>';

    document.getElementById('delete-offer-btn').addEventListener('click', async (e) => {
      const bouton = e.currentTarget;
      const ok = window.confirm(
        'Supprimer cette dette ?\n\n' +
        'Elle disparaîtra de la carte, ainsi que sa photo et toutes les demandes reçues. ' +
        'Cette action est définitive.'
      );
      if (!ok) return;

      setBusy(bouton, true, 'Suppression...');
      try {
        await deleteOffer(offer);
        currentOfferId = null;
        await refreshMarkers();
        showView('map');
      } catch (err) {
        alert(humanError(err));
        setBusy(bouton, false);
      }
    });
    return;
  }

  action.innerHTML = '<p class="hint">Chargement...</p>';
  if (await hasAlreadyRequested(offer.id)) {
    action.innerHTML = '<p class="success">Ta demande a déjà été envoyée !</p>';
    return;
  }

  action.innerHTML = '<button type="button" id="interest-btn">Je suis intéressé</button>';
  document.getElementById('interest-btn')
    .addEventListener('click', () => showRequestForm(offer, action));
}

function showRequestForm(offer, action) {
  action.innerHTML =
    '<form class="card" id="request-form">' +
      '<h3>Fais ta demande</h3>' +
      '<label>Ton prénom<input id="request-name" value="' + escapeHtml(user.name) + '" placeholder="Ton prénom" /></label>' +
      '<div class="photo-field">' +
        '<label style="margin-bottom:0">Ta photo</label>' +
        '<div class="photo-thumb-row">' +
          '<img id="request-preview" class="preview" style="display:none" alt="" />' +
          '<div class="photo-actions">' +
            '<button type="button" id="request-camera-btn">Ouvrir la caméra</button>' +
            '<input type="file" id="request-photo-fallback" accept="image/*" capture="user" style="display:none" />' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<label>Ton message pour te vendre<textarea id="request-message" maxlength="200" placeholder="Présente-toi en quelques mots..."></textarea></label>' +
      '<button type="submit" id="request-submit" disabled>Envoyer la demande</button>' +
    '</form>';

  let reqPhoto = null;

  function checkReqValid() {
    const name = document.getElementById('request-name').value.trim();
    const msg = document.getElementById('request-message').value.trim();
    document.getElementById('request-submit').disabled = !(reqPhoto && msg && name);
  }
  document.getElementById('request-name').addEventListener('input', checkReqValid);
  document.getElementById('request-message').addEventListener('input', checkReqValid);

  document.getElementById('request-camera-btn').addEventListener('click', () => {
    cameraFallbackInput = document.getElementById('request-photo-fallback');
    openCamera((dataUrl) => {
      reqPhoto = dataUrl;
      const img = document.getElementById('request-preview');
      img.src = dataUrl;
      img.style.display = 'block';
      checkReqValid();
    });
  });

  document.getElementById('request-photo-fallback').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      reqPhoto = reader.result;
      const img = document.getElementById('request-preview');
      img.src = reqPhoto;
      img.style.display = 'block';
      checkReqValid();
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('request-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('request-submit');
    const name = document.getElementById('request-name').value.trim();
    const msg = document.getElementById('request-message').value.trim();
    if (!reqPhoto || !msg || !name) return;

    setBusy(submitBtn, true, 'Envoi...');
    try {
      const photoUrl = await uploadPhoto(reqPhoto);
      await createRequest({ offerId: offer.id, name, photoUrl, message: msg });
      action.innerHTML = '<p class="success">Ta demande a été envoyée !</p>';
    } catch (err) {
      alert(humanError(err));
      setBusy(submitBtn, false);
    }
  });
}

/* ---------------------------------------------------------
   Vue « demandes »
   --------------------------------------------------------- */

async function renderInbox() {
  const rc = document.getElementById('inbox-received');
  const sc = document.getElementById('inbox-sent');
  rc.innerHTML = '<p class="hint">Chargement...</p>';
  sc.innerHTML = '';

  const [received, sent] = await Promise.all([
    fetchReceivedRequests(),
    fetchSentRequests(),
  ]);

  rc.innerHTML = received.length === 0
    ? '<p class="hint">Personne ne t\'a encore fait de demande.</p>'
    : received.map(r => {
        const placeName = r.offer ? r.offer.place_name : '';
        const actions = r.status === 'pending'
          ? '<div class="profile-actions">' +
              '<button class="btn-interest" data-accept="' + r.id + '">Intéressé</button>' +
              '<button class="btn-pass" data-decline="' + r.id + '">Pas intéressé</button>' +
            '</div>'
          : '<p class="' + (r.status === 'accepted' ? 'success' : 'error') + '">' +
              (r.status === 'accepted' ? 'Acceptée' : 'Refusée') +
            '</p>';
        return '<div class="card profile-card">' +
            '<div class="msg-bubble">' + escapeHtml(r.message) + '</div>' +
            '<div class="profile-photo-wrap">' +
              '<img src="' + escapeHtml(r.photo_url) + '" class="profile-photo" alt="" />' +
              '<div class="profile-badge" title="' + escapeHtml(placeName) + '">📍</div>' +
            '</div>' +
            '<p class="profile-name">' + escapeHtml(r.requester_name) + '</p>' +
            actions +
          '</div>';
      }).join('');

  sc.innerHTML = sent.length === 0
    ? '<p class="hint">Tu n\'as encore fait aucune demande.</p>'
    : sent.map(r => {
        const statusText = r.status === 'pending'
          ? 'En attente...'
          : r.status === 'accepted'
            ? 'Acceptée — vous pouvez vous rencontrer !'
            : 'Refusée';
        const cls = r.status === 'accepted' ? 'success' : r.status === 'declined' ? 'error' : 'hint';
        return '<div class="card requestCard">' +
            '<img src="' + escapeHtml(r.offer ? r.offer.photo_url : '') + '" class="preview" alt="" />' +
            '<div>' +
              '<strong>' + escapeHtml(r.offer ? r.offer.user_name : '') + '</strong>' +
              '<p class="hint">' + escapeHtml(r.offer ? r.offer.place_name : '') + '</p>' +
              '<p class="' + cls + '">' + statusText + '</p>' +
            '</div>' +
          '</div>';
      }).join('');

  rc.querySelectorAll('[data-accept]').forEach(btn =>
    btn.addEventListener('click', async () => {
      setBusy(btn, true, '...');
      try { await setRequestStatus(btn.dataset.accept, 'accepted'); await renderInbox(); }
      catch (err) { alert(humanError(err)); setBusy(btn, false); }
    })
  );
  rc.querySelectorAll('[data-decline]').forEach(btn =>
    btn.addEventListener('click', async () => {
      setBusy(btn, true, '...');
      try { await setRequestStatus(btn.dataset.decline, 'declined'); await renderInbox(); }
      catch (err) { alert(humanError(err)); setBusy(btn, false); }
    })
  );
}

/* ---------------------------------------------------------
   Accueil / connexion
   --------------------------------------------------------- */

document.getElementById('landing-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const name = document.getElementById('landing-name').value.trim();
  const birthdate = document.getElementById('landing-birthdate').value;
  const errEl = document.getElementById('landing-error');
  errEl.style.display = 'none';

  if (!name) { errEl.textContent = 'Entre un prénom.'; errEl.style.display = 'block'; return; }
  if (!birthdate) { errEl.textContent = 'Entre ta date de naissance.'; errEl.style.display = 'block'; return; }
  const age = Math.floor((Date.now() - new Date(birthdate).getTime()) / (365.25 * 24 * 3600 * 1000));
  if (age < 18) { errEl.textContent = 'Dette est réservé aux 18 ans et plus.'; errEl.style.display = 'block'; return; }

  setBusy(submitBtn, true, 'Un instant...');
  try {
    const { data } = await sb.auth.getSession();
    if (!data.session) throw new Error('Session expirée. Reconnecte-toi avec Google.');
    await saveProfile(data.session.user, name, birthdate);
    await enterApp();
  } catch (err) {
    errEl.textContent = humanError(err);
    errEl.style.display = 'block';
  } finally {
    setBusy(submitBtn, false);
  }
});

// Bouton « Continuer avec Google »
document.getElementById('btn-google').addEventListener('click', async (e) => {
  const errEl = document.getElementById('signin-error');
  errEl.style.display = 'none';
  setBusy(e.currentTarget, true, 'Redirection...');
  try {
    await signInWithGoogle();
  } catch (err) {
    errEl.textContent = humanError(err);
    errEl.style.display = 'block';
    setBusy(e.currentTarget, false);
  }
});

// « Changer de compte » depuis l'étape profil
document.getElementById('btn-signout-cancel').addEventListener('click', async () => {
  await sb.auth.signOut();
  document.getElementById('landing-name').value = '';
  document.getElementById('landing-birthdate').value = '';
  document.getElementById('landing-error').style.display = 'none';
  showSignInStep();
});

/* ---------------------------------------------------------
   Navigation
   --------------------------------------------------------- */

document.getElementById('btn-inbox').addEventListener('click', () => {
  showView('inbox');
  renderInbox();
});

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    showView(btn.dataset.nav);
    if (btn.dataset.nav === 'inbox') renderInbox();
  });
});

// Deux boutons de déconnexion : celui de la barre et celui du panneau d'identité.
async function logout() {
  stopRealtime();
  toggleProfilePanel(false);
  await sb.auth.signOut();
  user = null;
  offersCache = [];
  currentOfferId = null;
  document.getElementById('bottom-nav').style.display = 'none';
  document.getElementById('landing-name').value = '';
  document.getElementById('landing-birthdate').value = '';
  showSignInStep();
  showView('landing');
}

document.querySelectorAll('[data-logout]').forEach(btn =>
  btn.addEventListener('click', logout)
);

document.getElementById('offer-back').addEventListener('click', () => showView('map'));
document.getElementById('inbox-back').addEventListener('click', () => showView('map'));

/* ---------------------------------------------------------
   Démarrage
   --------------------------------------------------------- */

async function enterApp() {
  renderIdentity();
  document.getElementById('bottom-nav').style.display = 'flex';
  showView('map');
  if (!map) initMap();
  await refreshMarkers();
  startRealtime();
}

(async function boot() {
  try {
    const resultat = await inspectSession();
    if (resultat.etat === 'pret') { await enterApp(); return; }
    if (resultat.etat === 'profil-manquant') { showProfileStep(resultat.authUser); return; }
    showSignInStep();
  } catch (err) {
    console.error('Démarrage :', err);
    showSignInStep();
  }
})();
