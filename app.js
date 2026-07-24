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

// Ma demande sur cette offre (id + statut), ou null si je n'en ai pas envoyé.
async function getMyRequestForOffer(offerId) {
  const { data } = await sb
    .from('requests')
    .select('id, status')
    .eq('offer_id', offerId)
    .eq('requester_id', user.id)
    .maybeSingle();
  return data || null;
}

// Annuler / retirer sa demande.
async function cancelRequest(id) {
  const { error } = await sb.from('requests').delete().eq('id', id);
  if (error) throw error;
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
  const myReq = await getMyRequestForOffer(offer.id);

  if (myReq) {
    // Un match accepté se gère depuis la conversation (onglet Messages).
    if (myReq.status === 'accepted') {
      action.innerHTML = '<p class="success">Vous avez matché ! Retrouvez la conversation dans 💬 Messages.</p>';
      return;
    }
    // En attente ou refusée : on peut retirer sa demande.
    const refusee = myReq.status === 'declined';
    action.innerHTML =
      '<p class="' + (refusee ? 'error' : 'success') + '">' +
        (refusee ? 'Ta demande a été refusée.' : 'Ta demande a déjà été envoyée !') +
      '</p>' +
      '<button type="button" id="cancel-request-btn" class="btn-danger mt-3 w-full">🗑️ Annuler ma demande</button>';

    document.getElementById('cancel-request-btn').addEventListener('click', async (e) => {
      const ok = window.confirm('Annuler ta demande ?\n\nElle sera retirée. Tu pourras en refaire une plus tard si tu veux.');
      if (!ok) return;
      setBusy(e.currentTarget, true, 'Annulation...');
      try {
        await cancelRequest(myReq.id);
        renderOfferView(); // Recharge : le bouton « Je suis intéressé » réapparaît.
      } catch (err) {
        alert(humanError(err));
        setBusy(e.currentTarget, false);
      }
    });
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
              (r.status === 'accepted' ? 'Acceptée · 💬 Messages' : 'Refusée') +
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
            ? 'Acceptée — allez dans 💬 Messages'
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

/* =========================================================
   MESSAGERIE
   Une messagerie volontairement minimale, pensée pour amener
   à une vraie rencontre — pas pour discuter des semaines.
   Aucune notion de « en ligne », « vu » ou « écrit… ».
   ========================================================= */

let conversationsCache = [];
let chatOpenId = null;
let chatOther = null;       // { name, photo }
let chatMeetings = [];
let chatConfs = [];         // confirmations du rendez-vous en cours
let chatConvo = null;
let chatChannel = null;

const EMOJIS = ['😊','😄','😉','😍','🥰','😂','👍','🙌','🎉','☕','🍸','🍕','🚶','🎬','🌸','❤️','🔥','✨','🙏','👋'];

// Seuils de la suggestion douce « et si vous vous rencontriez ? »
const NUDGE_MIN_MESSAGES = 10;
const NUDGE_MIN_DAYS = 2;

/* ---------- Suivi local du « déjà lu » (jamais montré à l'autre) ---------- */
function getSeenMap() { return read('dette_seen', {}); }
function markConversationSeen(convoId, iso) {
  const m = getSeenMap();
  m[convoId] = iso || new Date().toISOString();
  write('dette_seen', m);
}
function conversationHasUnread(convo) {
  const last = convo.last_message;
  if (!last || last.sender_id === user.id) return false;
  const seen = getSeenMap()[convo.id];
  return !seen || new Date(last.created_at) > new Date(seen);
}

/* ---------- Formatage des dates (léger, en français) ---------- */
function fmtTime(d) {
  return new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
function fmtDayLabel(d) {
  const date = new Date(d);
  const auj = new Date(); auj.setHours(0, 0, 0, 0);
  const j = new Date(date); j.setHours(0, 0, 0, 0);
  const diff = Math.round((auj - j) / 86400000);
  if (diff === 0) return "Aujourd'hui";
  if (diff === 1) return 'Hier';
  return date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}
function fmtMeetingWhen(d) {
  return new Date(d).toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
}
function fmtRelative(d) {
  const diff = new Date(d) - Date.now();
  const abs = Math.abs(diff);
  const h = Math.floor(abs / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  const jour = Math.floor(h / 24);
  let texte;
  if (jour >= 1) texte = jour + (jour > 1 ? ' jours' : ' jour');
  else if (h >= 1) texte = h + ' h' + (m ? ' ' + m + ' min' : '');
  else texte = m + ' min';
  return diff >= 0 ? 'dans ' + texte : 'il y a ' + texte;
}

/* ---------- Accès aux données ---------- */

// « L'autre personne » selon qui je suis dans la conversation.
function otherOf(convo) {
  if (convo.owner_id === user.id) {
    return { name: convo.request?.requester_name || 'Anonyme', photo: convo.request?.photo_url || '' };
  }
  return { name: convo.offer?.user_name || 'Anonyme', photo: convo.offer?.photo_url || '' };
}

async function fetchConversations() {
  const { data, error } = await sb
    .from('conversations')
    .select('*, offer:offers(user_name, photo_url, place_name), request:requests(requester_name, photo_url)')
    .or('owner_id.eq.' + user.id + ',guest_id.eq.' + user.id)
    .order('last_message_at', { ascending: false });
  if (error) { console.error(error); return conversationsCache; }

  const convos = data || [];
  // Dernier message de chaque conversation (une seule requête).
  const ids = convos.map(c => c.id);
  if (ids.length) {
    const { data: msgs } = await sb
      .from('messages')
      .select('conversation_id, body, sender_id, created_at')
      .in('conversation_id', ids)
      .order('created_at', { ascending: false });
    const dernier = {};
    (msgs || []).forEach(m => { if (!dernier[m.conversation_id]) dernier[m.conversation_id] = m; });
    convos.forEach(c => { c.last_message = dernier[c.id] || null; });
  }
  conversationsCache = convos;
  return convos;
}

async function fetchMessages(convoId) {
  const { data, error } = await sb
    .from('messages')
    .select('*')
    .eq('conversation_id', convoId)
    .order('created_at', { ascending: true });
  if (error) { console.error(error); return []; }
  return data || [];
}

async function sendMessage(convoId, body) {
  const { error } = await sb.from('messages').insert({
    conversation_id: convoId, sender_id: user.id, body,
  });
  if (error) throw error;
}

async function fetchMeetings(convoId) {
  const { data } = await sb
    .from('meetings')
    .select('*')
    .eq('conversation_id', convoId)
    .order('created_at', { ascending: false });
  return data || [];
}

async function fetchConfirmations(meetingId) {
  const { data } = await sb
    .from('meeting_confirmations')
    .select('*')
    .eq('meeting_id', meetingId);
  return data || [];
}

async function proposeMeeting(convoId, meetAtIso, place) {
  const { error } = await sb.from('meetings').insert({
    conversation_id: convoId, proposer_id: user.id, meet_at: meetAtIso, place,
  });
  if (error) throw error;
}

async function respondMeeting(meetingId, status) {
  const { error } = await sb.from('meetings').update({ status }).eq('id', meetingId);
  if (error) throw error;
}

// Met fin à une conversation (le match). Cascade : messages + rendez-vous éventuel.
async function deleteConversation(convoId) {
  const { error } = await sb.from('conversations').delete().eq('id', convoId);
  if (error) throw error;
}

async function confirmMeeting(meeting, attended) {
  const { error } = await sb.from('meeting_confirmations').insert({
    meeting_id: meeting.id, conversation_id: meeting.conversation_id,
    user_id: user.id, attended,
  });
  if (error) throw error;
}

/* ---------- Liste des conversations ---------- */

async function renderConversations() {
  const cont = document.getElementById('conversations-list');
  cont.innerHTML = '<p class="hint">Chargement...</p>';
  const convos = await fetchConversations();
  updateNavDot();

  if (!convos.length) {
    cont.innerHTML =
      '<div class="card items-center text-center">' +
        '<div class="text-3xl">💬</div>' +
        '<p class="text-[14px] font-semibold text-ink-700">Aucune conversation pour l\'instant</p>' +
        '<p class="hint">Une conversation s\'ouvre dès qu\'une demande est acceptée, d\'un côté ou de l\'autre.</p>' +
      '</div>';
    return;
  }

  cont.innerHTML = convos.map(c => {
    const o = otherOf(c);
    const apercu = c.last_message
      ? (c.last_message.sender_id === user.id ? 'Vous : ' : '') + c.last_message.body
      : 'Dites bonjour 👋';
    const heure = c.last_message ? fmtTime(c.last_message.created_at) : '';
    const avatar = o.photo
      ? '<img src="' + escapeHtml(o.photo) + '" class="avatar" referrerpolicy="no-referrer" alt="" />'
      : '<span class="initial">' + escapeHtml((o.name[0] || '?').toUpperCase()) + '</span>';
    const pastille = conversationHasUnread(c) ? '<span class="convo-badge">•</span>' : '';
    return '<button type="button" class="convo-row" data-convo="' + c.id + '">' +
        avatar +
        '<div class="min-w-0 flex-1">' +
          '<div class="flex items-center gap-2"><span class="convo-name">' + escapeHtml(o.name) + '</span>' +
            (c.unlocked ? '<span class="text-xs">🎉</span>' : '') +
            '<span class="convo-time ml-auto">' + heure + '</span></div>' +
          '<p class="convo-preview">' + escapeHtml(apercu) + '</p>' +
        '</div>' + pastille +
      '</button>';
  }).join('');

  cont.querySelectorAll('[data-convo]').forEach(btn =>
    btn.addEventListener('click', () => openConversation(btn.dataset.convo))
  );
}

function updateNavDot() {
  const nBrut = conversationsCache.some(conversationHasUnread);
  const dot = document.getElementById('nav-messages-dot');
  if (dot) dot.style.display = nBrut ? 'block' : 'none';
}

/* ---------- Ouverture d'une conversation ---------- */

async function openConversation(convoId) {
  chatConvo = conversationsCache.find(c => c.id === convoId) || null;
  if (!chatConvo) { await fetchConversations(); chatConvo = conversationsCache.find(c => c.id === convoId) || null; }
  if (!chatConvo) return;

  chatOpenId = convoId;
  chatOther = otherOf(chatConvo);

  // En-tête
  const av = document.getElementById('chat-avatar');
  const ini = document.getElementById('chat-initial');
  if (chatOther.photo) {
    av.src = chatOther.photo; av.style.display = 'block'; ini.style.display = 'none';
    av.onerror = () => { av.style.display = 'none'; ini.style.display = 'flex'; };
  } else { av.style.display = 'none'; ini.style.display = 'flex'; }
  ini.textContent = (chatOther.name[0] || '?').toUpperCase();
  document.getElementById('chat-name').textContent = chatOther.name;
  document.getElementById('chat-sub').textContent = chatConvo.unlocked
    ? 'Vous vous êtes rencontrés 🎉'
    : 'Vous avez matché — faites connaissance';

  showView('chat');
  setMessagesTabActive();

  const [msgs, meetings] = await Promise.all([fetchMessages(convoId), fetchMeetings(convoId)]);
  chatMeetings = meetings;
  const active = latestRelevantMeeting();
  chatConfs = active ? await fetchConfirmations(active.id) : [];

  renderMessages(msgs);
  renderMeetingArea();
  renderNudge(msgs.length);

  const last = msgs[msgs.length - 1];
  markConversationSeen(convoId, last ? last.created_at : new Date().toISOString());
  updateNavDot();
  scrollChatToBottom();
}

function setMessagesTabActive() {
  document.querySelectorAll('.nav-item').forEach(b =>
    b.classList.toggle('active', b.dataset.nav === 'messages'));
}

function scrollChatToBottom() {
  const s = document.getElementById('chat-scroll');
  requestAnimationFrame(() => { s.scrollTop = s.scrollHeight; });
}

/* ---------- Rendu des messages ---------- */

function renderMessages(msgs) {
  const cont = document.getElementById('chat-messages');
  if (!msgs.length) {
    cont.innerHTML = '<p class="hint">Dites simplement bonjour 👋</p>';
    return;
  }
  let html = '';
  let dernierJour = '';
  msgs.forEach(m => {
    const jour = fmtDayLabel(m.created_at);
    if (jour !== dernierJour) { html += '<div class="day-sep">' + jour + '</div>'; dernierJour = jour; }
    const mine = m.sender_id === user.id;
    html += '<div class="bubble-row ' + (mine ? 'mine' : 'theirs') + '">' +
        '<div>' +
          '<div class="bubble ' + (mine ? 'mine' : 'theirs') + '">' + escapeHtml(m.body) + '</div>' +
          '<div class="bubble-time">' + fmtTime(m.created_at) + '</div>' +
        '</div>' +
      '</div>';
  });
  cont.innerHTML = html;
}

function appendMessage(m) {
  // Ajout léger sans tout re-render (réception temps réel).
  const cont = document.getElementById('chat-messages');
  if (cont.querySelector('.hint')) cont.innerHTML = '';
  const mine = m.sender_id === user.id;
  const div = document.createElement('div');
  div.className = 'bubble-row ' + (mine ? 'mine' : 'theirs');
  div.innerHTML = '<div><div class="bubble ' + (mine ? 'mine' : 'theirs') + '">' +
    escapeHtml(m.body) + '</div><div class="bubble-time">' + fmtTime(m.created_at) + '</div></div>';
  cont.appendChild(div);
  scrollChatToBottom();
}

/* ---------- Rendez-vous ---------- */

// La proposition la plus récente qui n'est ni refusée ni annulée.
function latestRelevantMeeting() {
  return chatMeetings.find(m => m.status === 'pending' || m.status === 'accepted') || null;
}

function myConfirmation() {
  return chatConfs.find(c => c.user_id === user.id) || null;
}

function renderMeetingArea() {
  const zone = document.getElementById('chat-meeting');
  const m = latestRelevantMeeting();

  if (!m) { zone.innerHTML = ''; return; }

  const quand = fmtMeetingWhen(m.meet_at);
  const passe = new Date(m.meet_at) < new Date();

  // ---- Proposition en attente ----
  if (m.status === 'pending') {
    if (m.proposer_id === user.id) {
      zone.innerHTML =
        '<div class="meeting-card">' +
          '<div class="head">📅 Proposition envoyée</div>' +
          '<div class="detail">📍 ' + escapeHtml(m.place) + '</div>' +
          '<div class="detail">🕒 ' + quand + '</div>' +
          '<p class="muted">En attente de sa réponse. Pas de pression — laissez-lui le temps.</p>' +
          '<button type="button" class="btn-danger" data-meet-cancel="' + m.id + '">Annuler la proposition</button>' +
        '</div>';
    } else {
      zone.innerHTML =
        '<div class="meeting-card">' +
          '<div class="head">📅 ' + escapeHtml(chatOther.name) + ' propose une rencontre</div>' +
          '<div class="detail">📍 ' + escapeHtml(m.place) + '</div>' +
          '<div class="detail">🕒 ' + quand + '</div>' +
          '<div class="meeting-actions">' +
            '<button type="button" class="btn-interest" data-meet-accept="' + m.id + '">Accepter</button>' +
            '<button type="button" class="btn-pass" data-meet-decline="' + m.id + '">Refuser</button>' +
          '</div>' +
          '<button type="button" class="ghost" data-meet-counter="1">Proposer un autre créneau</button>' +
        '</div>';
    }
  }

  // ---- Rendez-vous accepté ----
  else if (m.status === 'accepted') {
    if (!passe) {
      zone.innerHTML =
        '<div class="meeting-card">' +
          '<div class="head">✅ Rencontre prévue</div>' +
          '<div class="detail">📍 ' + escapeHtml(m.place) + '</div>' +
          '<div class="detail">🕒 ' + quand + '</div>' +
          '<div><span class="countdown">⏳ ' + fmtRelative(m.meet_at) + '</span></div>' +
        '</div>';
    } else {
      const conf = myConfirmation();
      if (!conf) {
        zone.innerHTML =
          '<div class="meeting-card">' +
            '<div class="head">💛 Avez-vous bien eu votre rendez-vous ?</div>' +
            '<div class="meeting-actions">' +
              '<button type="button" class="btn-interest" data-meet-yes="' + m.id + '">✅ Oui</button>' +
              '<button type="button" class="btn-pass" data-meet-no="' + m.id + '">❌ Non</button>' +
            '</div>' +
          '</div>';
      } else if (conf.attended) {
        zone.innerHTML =
          '<div class="meeting-card">' +
            '<div class="head">💛 Merci !</div>' +
            '<p class="muted">' + (chatConvo.unlocked
              ? 'Vous vous êtes rencontrés tous les deux. La conversation est désormais libre.'
              : 'En attente de sa confirmation de son côté.') + '</p>' +
          '</div>';
      } else {
        zone.innerHTML =
          '<div class="meeting-card"><div class="head">Rendez-vous manqué</div>' +
            '<p class="muted">Vous pouvez en proposer un autre quand vous voulez.</p></div>';
      }
    }
  }

  // Boutons du bandeau
  zone.querySelectorAll('[data-meet-accept]').forEach(b => b.addEventListener('click', () => onRespondMeeting(b.dataset.meetAccept, 'accepted')));
  zone.querySelectorAll('[data-meet-decline]').forEach(b => b.addEventListener('click', () => onRespondMeeting(b.dataset.meetDecline, 'declined')));
  zone.querySelectorAll('[data-meet-cancel]').forEach(b => b.addEventListener('click', () => onRespondMeeting(b.dataset.meetCancel, 'cancelled')));
  zone.querySelectorAll('[data-meet-counter]').forEach(b => b.addEventListener('click', openMeetingSheet));
  zone.querySelectorAll('[data-meet-yes]').forEach(b => b.addEventListener('click', () => onConfirmMeeting(b.dataset.meetYes, true)));
  zone.querySelectorAll('[data-meet-no]').forEach(b => b.addEventListener('click', () => onConfirmMeeting(b.dataset.meetNo, false)));
}

async function onRespondMeeting(meetingId, status) {
  try {
    await respondMeeting(meetingId, status);
    await reloadChatMeetings();
  } catch (err) { alert(humanError(err)); }
}

async function onConfirmMeeting(meetingId, attended) {
  try {
    const m = chatMeetings.find(x => x.id === meetingId);
    await confirmMeeting(m, attended);
    await reloadChatMeetings();
  } catch (err) { alert(humanError(err)); }
}

async function reloadChatMeetings() {
  chatMeetings = await fetchMeetings(chatOpenId);
  // Recharge la conversation (pour l'état « unlocked ») et les confirmations.
  const active = latestRelevantMeeting();
  chatConfs = active ? await fetchConfirmations(active.id) : [];
  const { data } = await sb.from('conversations').select('unlocked').eq('id', chatOpenId).maybeSingle();
  if (data) chatConvo.unlocked = data.unlocked;
  renderMeetingArea();
  renderNudge(document.querySelectorAll('#chat-messages .bubble').length);
}

/* ---------- Suggestion douce ---------- */

function renderNudge(messageCount) {
  const zone = document.getElementById('chat-nudge');
  const m = latestRelevantMeeting();

  // Pas de suggestion si un rendez-vous est déjà en cours, ou si déjà rencontrés.
  if (m || chatConvo.unlocked) { zone.innerHTML = ''; return; }

  const joursEcoules = (Date.now() - new Date(chatConvo.created_at)) / 86400000;
  const assez = messageCount >= NUDGE_MIN_MESSAGES || joursEcoules >= NUDGE_MIN_DAYS;
  if (!assez) { zone.innerHTML = ''; return; }

  zone.innerHTML =
    '<div class="nudge-card">' +
      '<div class="text-2xl">✨</div>' +
      '<p>Vous semblez bien vous entendre. Pourquoi ne pas organiser votre première rencontre ?</p>' +
      '<button type="button" id="nudge-propose">📅 Proposer une rencontre</button>' +
    '</div>';
  document.getElementById('nudge-propose').addEventListener('click', openMeetingSheet);
}

/* ---------- Feuille de proposition ---------- */

function openMeetingSheet() {
  const f = document.getElementById('meeting-form');
  f.reset();
  document.getElementById('meeting-error').style.display = 'none';
  document.getElementById('meeting-overlay').classList.add('active');
}
function closeMeetingSheet() {
  document.getElementById('meeting-overlay').classList.remove('active');
}
document.getElementById('meeting-cancel').addEventListener('click', closeMeetingSheet);
document.getElementById('meeting-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'meeting-overlay') closeMeetingSheet();
});
document.getElementById('chat-propose').addEventListener('click', openMeetingSheet);

document.getElementById('meeting-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('meeting-submit');
  const errEl = document.getElementById('meeting-error');
  errEl.style.display = 'none';
  const date = document.getElementById('meeting-date').value;
  const time = document.getElementById('meeting-time').value;
  const place = document.getElementById('meeting-place').value.trim();

  if (!date || !time) { errEl.textContent = 'Choisis un jour et une heure.'; errEl.style.display = 'block'; return; }
  if (!place) { errEl.textContent = 'Indique un lieu.'; errEl.style.display = 'block'; return; }
  const meetAt = new Date(date + 'T' + time);
  if (isNaN(meetAt) || meetAt < new Date()) { errEl.textContent = 'Choisis un moment à venir.'; errEl.style.display = 'block'; return; }

  setBusy(btn, true, 'Envoi...');
  try {
    await proposeMeeting(chatOpenId, meetAt.toISOString(), place);
    closeMeetingSheet();
    await reloadChatMeetings();
    scrollChatToBottom();
  } catch (err) {
    errEl.textContent = humanError(err); errEl.style.display = 'block';
  } finally {
    setBusy(btn, false);
  }
});

/* ---------- Zone de saisie (texte + emojis uniquement) ---------- */

const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');

chatInput.addEventListener('input', () => {
  chatSend.disabled = chatInput.value.trim().length === 0;
});

document.getElementById('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = chatInput.value.trim();
  if (!body || !chatOpenId) return;
  chatInput.value = '';
  chatSend.disabled = true;
  try {
    await sendMessage(chatOpenId, body);
    // Le message revient par le temps réel ; on l'ajoute tout de suite pour la fluidité.
  } catch (err) {
    alert(humanError(err));
    chatInput.value = body;
  }
});

// Barre d'emojis
const emojiBar = document.getElementById('chat-emoji-bar');
emojiBar.innerHTML = EMOJIS.map(e => '<button type="button">' + e + '</button>').join('');
emojiBar.querySelectorAll('button').forEach(b =>
  b.addEventListener('click', () => {
    chatInput.value += b.textContent;
    chatSend.disabled = chatInput.value.trim().length === 0;
    chatInput.focus();
  })
);
document.getElementById('chat-emoji-btn').addEventListener('click', () => {
  emojiBar.style.display = emojiBar.style.display === 'none' ? 'flex' : 'none';
});

document.getElementById('chat-back').addEventListener('click', () => {
  chatOpenId = null;
  emojiBar.style.display = 'none';
  showView('messages');
  renderConversations();
});

document.getElementById('chat-delete').addEventListener('click', async () => {
  if (!chatOpenId) return;
  const ok = window.confirm(
    'Mettre fin à cette conversation ?\n\n' +
    'Elle disparaîtra pour vous deux, avec les messages et le rendez-vous éventuel. ' +
    'Cette action est définitive.'
  );
  if (!ok) return;
  const id = chatOpenId;
  try {
    await deleteConversation(id);
    chatOpenId = null;
    emojiBar.style.display = 'none';
    showView('messages');
    renderConversations();
  } catch (err) {
    alert(humanError(err));
  }
});

/* ---------- Temps réel de la messagerie ---------- */

function startChatRealtime() {
  if (chatChannel) return;
  chatChannel = sb
    .channel('dette-chat')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
      const m = payload.new;
      if (chatOpenId && m.conversation_id === chatOpenId) {
        appendMessage(m);
        markConversationSeen(chatOpenId, m.created_at);
        renderNudge(document.querySelectorAll('#chat-messages .bubble').length);
      } else {
        // Message dans une autre conversation : on rafraîchit la pastille.
        fetchConversations().then(updateNavDot);
        if (document.getElementById('view-messages').classList.contains('active')) renderConversations();
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'meetings' }, (payload) => {
      const row = payload.new || payload.old;
      if (chatOpenId && row.conversation_id === chatOpenId) reloadChatMeetings();
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' }, (payload) => {
      if (chatOpenId && payload.new.id === chatOpenId) {
        chatConvo.unlocked = payload.new.unlocked;
        renderMeetingArea();
      }
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'conversations' }, (payload) => {
      const supprimee = payload.old && payload.old.id;
      if (chatOpenId && supprimee === chatOpenId) {
        chatOpenId = null;
        emojiBar.style.display = 'none';
        alert('Cette conversation a été terminée.');
        showView('messages');
        renderConversations();
      } else {
        fetchConversations().then(updateNavDot);
      }
    })
    .subscribe();
}

function stopChatRealtime() {
  if (chatChannel) { sb.removeChannel(chatChannel); chatChannel = null; }
}

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
    if (btn.dataset.nav === 'messages') renderConversations();
  });
});

// Deux boutons de déconnexion : celui de la barre et celui du panneau d'identité.
async function logout() {
  stopRealtime();
  stopChatRealtime();
  toggleProfilePanel(false);
  await sb.auth.signOut();
  user = null;
  offersCache = [];
  conversationsCache = [];
  chatOpenId = null;
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
  startChatRealtime();
  // Amorce la pastille « nouveaux messages » sans ouvrir l'onglet.
  fetchConversations().then(updateNavDot).catch(() => {});
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
