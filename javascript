const KEY_USER = 'dette_user';
const KEY_OFFERS = 'dette_offers';
const KEY_REQUESTS = 'dette_requests';

function read(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
}
function write(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function getCurrentUser() { return read(KEY_USER, null); }
function setCurrentUser(u) { write(KEY_USER, u); }
function logout() { localStorage.removeItem(KEY_USER); }
function getOffers() { return read(KEY_OFFERS, []); }
function addOffer(offer) {
  const offers = getOffers();
  const o = { id: crypto.randomUUID(), createdAt: Date.now(), status: 'active', ...offer };
  write(KEY_OFFERS, [o, ...offers]);
  return o;
}
function getOffer(id) { return getOffers().find(o => o.id === id) || null; }
function getRequests() { return read(KEY_REQUESTS, []); }
function addRequest(req) {
  const requests = getRequests();
  const r = { id: crypto.randomUUID(), createdAt: Date.now(), status: 'pending', ...req };
  write(KEY_REQUESTS, [r, ...requests]);
  return r;
}
function updateRequestStatus(id, status) {
  write(KEY_REQUESTS, getRequests().map(r => r.id === id ? { ...r, status } : r));
}
function getRequestsForOfferOwner(userId) {
  const myOfferIds = getOffers().filter(o => o.userId === userId).map(o => o.id);
  return getRequests().filter(r => myOfferIds.includes(r.offerId));
}
function getMyRequests(userId) { return getRequests().filter(r => r.requesterId === userId); }

let user = null;
let map = null;
let markersLayer = null;
let pickedLocation = null;
let createPhotoData = null;
let currentOfferId = null;

let cameraStream = null;
let cameraFacingMode = 'user';
let cameraCallback = null;
let cameraFallbackInput = null;

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.nav === name);
  });
  if (name === 'map') setTimeout(() => map && map.invalidateSize(), 50);
}

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
  refreshMarkers();
}

function refreshMarkers() {
  markersLayer.clearLayers();
  getOffers().filter(o => o.status === 'active').forEach(o => {
    const m = L.marker([o.lat, o.lng], { icon: pinIcon('❤️') });
    m.on('click', () => { currentOfferId = o.id; renderOfferView(); showView('offer'); });
    m.bindPopup(o.placeName || 'Un lieu');
    m.addTo(markersLayer);
  });
}

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

document.getElementById('create-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const place = document.getElementById('create-place').value.trim() || 'Lieu choisi';
  const message = document.getElementById('create-message').value.trim();
  if (!createPhotoData || !message || !pickedLocation) return;
  addOffer({
    userId: user.id, userName: user.name,
    lat: pickedLocation.lat, lng: pickedLocation.lng,
    placeName: place, photo: createPhotoData, message
  });
  refreshMarkers();
  closeCreateSheet();
});

function openCamera(callback) {
  cameraCallback = callback;
  document.getElementById('camera-overlay').classList.add('active');
  startCameraStream();
}
async function startCameraStream() {
  stopCameraStream();
  const hint = document.getElementById('camera-hint');
  hint.textContent = 'Cadre ton visage puis appuie sur le bouton pour te prendre en photo.';
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
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  closeCamera();
  if (cameraCallback) cameraCallback(dataUrl);
});

function renderOfferView() {
  const offer = getOffer(currentOfferId);
  const detail = document.getElementById('offer-detail');
  const action = document.getElementById('offer-action');
  if (!offer) { detail.innerHTML = '<p>Offre introuvable.</p>'; action.innerHTML = ''; return; }
  detail.innerHTML =
    '<div class="profile-card">' +
      '<div class="msg-bubble">' + escapeHtml(offer.message) + '</div>' +
      '<div class="profile-photo-wrap"><img src="' + offer.photo + '" class="profile-photo" /><div class="profile-badge" title="' + escapeHtml(offer.placeName) + '">📍</div></div>' +
      '<p class="profile-name">' + escapeHtml(offer.userName) + '</p>' +
    '</div>';

  if (offer.userId === user.id) {
    action.innerHTML = '<p class="hint">C\'est ta propre offre. Regarde tes demandes reçues dans "Demandes".</p>';
    return;
  }
  const already = getMyRequests(user.id).some(r => r.offerId === offer.id);
  if (already) {
    action.innerHTML = '<p class="success">Ta demande a déjà été envoyée !</p>';
    return;
  }

  action.innerHTML = '<button type="button" id="interest-btn">Je suis intéressé</button>';
  document.getElementById('interest-btn').addEventListener('click', () => showRequestForm(offer, action));
}

function showRequestForm(offer, action) {
  action.innerHTML =
    '<form class="card" id="request-form">' +
      '<h3>Fais ta demande</h3>' +
      '<label>Ton prénom<input id="request-name" value="' + escapeHtml(user.name) + '" placeholder="Ton prénom" /></label>' +
      '<div class="photo-field">' +
        '<label style="margin-bottom:0">Ta photo</label>' +
        '<div class="photo-thumb-row">' +
          '<img id="request-preview" class="preview" style="display:none" />' +
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
      img.src = dataUrl; img.style.display = 'block';
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
      img.src = reqPhoto; img.style.display = 'block';
      checkReqValid();
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('request-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('request-name').value.trim();
    const msg = document.getElementById('request-message').value.trim();
    if (!reqPhoto || !msg || !name) return;
    addRequest({ offerId: offer.id, requesterId: user.id, requesterName: name, photo: reqPhoto, message: msg });
    action.innerHTML = '<p class="success">Ta demande a été envoyée !</p>';
  });
}

function renderInbox() {
  const received = getRequestsForOfferOwner(user.id);
  const sent = getMyRequests(user.id);
  const rc = document.getElementById('inbox-received');
  const sc = document.getElementById('inbox-sent');

  rc.innerHTML = received.length === 0
    ? '<p class="hint">Personne ne t\'a encore fait de demande.</p>'
    : received.map(r => {
        const offer = getOffer(r.offerId);
        const placeName = offer ? offer.placeName : '';
        const actions = r.status === 'pending'
          ? '<div class="profile-actions"><button class="btn-interest" data-accept="' + r.id + '">Intéressé</button><button class="btn-pass" data-decline="' + r.id + '">Pas intéressé</button></div>'
          : '<p class="' + (r.status === 'accepted' ? 'success' : 'error') + '">' + (r.status === 'accepted' ? 'Acceptée' : 'Refusée') + '</p>';
        return '<div class="card profile-card">' +
          '<div class="msg-bubble">' + escapeHtml(r.message) + '</div>' +
          '<div class="profile-photo-wrap"><img src="' + r.photo + '" class="profile-photo" /><div class="profile-badge" title="' + escapeHtml(placeName) + '">\uD83D\uDCCD</div></div>' +
          '<p class="profile-name">' + escapeHtml(r.requesterName) + '</p>' +
          actions +
        '</div>';
      }).join('');

  sc.innerHTML = sent.length === 0
    ? '<p class="hint">Tu n\'as encore fait aucune demande.</p>'
    : sent.map(r => {
        const offer = getOffer(r.offerId);
        const statusText = r.status === 'pending' ? 'En attente...' : r.status === 'accepted' ? 'Acceptée — vous pouvez vous rencontrer !' : 'Refusée';
        const cls = r.status === 'accepted' ? 'success' : r.status === 'declined' ? 'error' : 'hint';
        return '<div class="card requestCard"><img src="' + (offer ? offer.photo : '') + '" class="preview" /><div><strong>' + escapeHtml(offer ? offer.userName : '') + '</strong><p class="hint">' + escapeHtml(offer ? offer.placeName : '') + '</p><p class="' + cls + '">' + statusText + '</p></div></div>';
      }).join('');

  rc.querySelectorAll('[data-accept]').forEach(btn => btn.addEventListener('click', () => { updateRequestStatus(btn.dataset.accept, 'accepted'); renderInbox(); }));
  rc.querySelectorAll('[data-decline]').forEach(btn => btn.addEventListener('click', () => { updateRequestStatus(btn.dataset.decline, 'declined'); renderInbox(); }));
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s == null ? '' : s;
  return div.innerHTML;
}

document.getElementById('landing-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('landing-name').value.trim();
  const birthdate = document.getElementById('landing-birthdate').value;
  const errEl = document.getElementById('landing-error');
  errEl.style.display = 'none';
  if (!name) { errEl.textContent = 'Entre un prénom.'; errEl.style.display = 'block'; return; }
  if (!birthdate) { errEl.textContent = 'Entre ta date de naissance.'; errEl.style.display = 'block'; return; }
  const age = Math.floor((Date.now() - new Date(birthdate).getTime()) / (365.25*24*3600*1000));
  if (age < 18) { errEl.textContent = 'Dette est réservé aux 18 ans et plus.'; errEl.style.display = 'block'; return; }
  user = { id: crypto.randomUUID(), name };
  setCurrentUser(user);
  enterApp();
});

document.getElementById('btn-inbox').addEventListener('click', () => { renderInbox(); showView('inbox'); });
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.nav === 'inbox') renderInbox();
    showView(btn.dataset.nav);
  });
});

document.getElementById('btn-logout').addEventListener('click', () => { logout(); user = null; document.getElementById('bottom-nav').style.display = 'none'; showView('landing'); });
document.getElementById('offer-back').addEventListener('click', () => showView('map'));
document.getElementById('inbox-back').addEventListener('click', () => showView('map'));

function enterApp() {
  document.getElementById('bottom-nav').style.display = 'flex';
  showView('map');
  if (!map) initMap(); else refreshMarkers();
}

(function boot() {
  const existing = getCurrentUser();
  if (existing) { user = existing; enterApp(); }
})();
