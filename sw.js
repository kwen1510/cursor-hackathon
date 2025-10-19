// Teach(er) PWA Service Worker
// Version 1.0.2 - Fixed CDN caching

const CACHE_NAME = 'teacher-v1.0.2';
const RUNTIME_CACHE = 'teacher-runtime-v1.0.2';

// Assets to cache on install (only local resources, CDNs cached at runtime)
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker...');
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        console.log('[SW] Service worker installed successfully');
        return self.skipWaiting();
      })
      .catch((error) => {
        console.error('[SW] Installation failed:', error);
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker...');
  
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((cacheName) => {
              return cacheName !== CACHE_NAME && cacheName !== RUNTIME_CACHE;
            })
            .map((cacheName) => {
              console.log('[SW] Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            })
        );
      })
      .then(() => {
        console.log('[SW] Service worker activated');
        return self.clients.claim();
      })
  );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  
  // Skip cross-origin requests
  if (url.origin !== location.origin) {
    return;
  }
  
  // Skip Chrome extension requests
  if (url.protocol === 'chrome-extension:') {
    return;
  }
  
  // Network-first strategy for API calls
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Clone the response
          const responseToCache = response.clone();
          
          // Cache successful GET responses only (POST/PUT/DELETE can't be cached)
          if (response.ok && request.method === 'GET') {
            caches.open(RUNTIME_CACHE)
              .then((cache) => {
                cache.put(request, responseToCache);
              });
          }
          
          return response;
        })
        .catch(() => {
          // Fallback to cache if network fails (only for GET requests)
          if (request.method === 'GET') {
            return caches.match(request).then(cachedResponse => {
              if (cachedResponse) {
                return cachedResponse;
              }
              // No cache available, return error
              return new Response(JSON.stringify({ error: 'Offline and no cache available' }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
              });
            });
          }
          // For non-GET requests, return error response
          return new Response(JSON.stringify({ error: 'Network unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        })
    );
    return;
  }
  
  // Cache-first strategy for static assets
  event.respondWith(
    caches.match(request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          console.log('[SW] Serving from cache:', url.pathname);
          return cachedResponse;
        }
        
        // Fetch from network and cache
        return fetch(request)
          .then((response) => {
            // Don't cache opaque responses
            if (!response || response.status !== 200 || response.type === 'opaque') {
              return response;
            }
            
            const responseToCache = response.clone();
            
            caches.open(RUNTIME_CACHE)
              .then((cache) => {
                cache.put(request, responseToCache);
              });
            
            return response;
          })
          .catch((error) => {
            console.error('[SW] Fetch failed:', error);
            
            // Return offline page for navigation requests
            if (request.mode === 'navigate') {
              return caches.match('/');
            }
            
            throw error;
          });
      })
  );
});

// Background Sync for failed uploads
self.addEventListener('sync', (event) => {
  console.log('[SW] Background sync triggered:', event.tag);
  
  if (event.tag === 'upload-recording-chunks') {
    event.waitUntil(uploadPendingChunks());
  }
});

// Upload pending chunks from IndexedDB
async function uploadPendingChunks() {
  try {
    console.log('[SW] Attempting to upload pending chunks...');
    
    // Open IndexedDB
    const db = await openIndexedDB();
    const tx = db.transaction('chunks', 'readonly');
    const store = tx.objectStore('chunks');
    const allChunks = await store.getAll();
    
    // Find chunks that haven't been uploaded
    const pendingChunks = allChunks.filter(chunk => !chunk.uploaded);
    
    console.log(`[SW] Found ${pendingChunks.length} pending chunks`);
    
    for (const chunk of pendingChunks) {
      try {
        await uploadChunk(chunk);
        
        // Mark as uploaded
        const txWrite = db.transaction('chunks', 'readwrite');
        const storeWrite = txWrite.objectStore('chunks');
        chunk.uploaded = true;
        await storeWrite.put(chunk);
        
        console.log('[SW] Successfully uploaded chunk:', chunk.key);
      } catch (error) {
        console.error('[SW] Failed to upload chunk:', chunk.key, error);
      }
    }
    
    console.log('[SW] Background sync complete');
  } catch (error) {
    console.error('[SW] Background sync failed:', error);
    throw error;
  }
}

// Helper to open IndexedDB
function openIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('LessonRecordings', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

// Helper to upload a chunk
async function uploadChunk(chunk) {
  const formData = new FormData();
  formData.append('audio', chunk.blob);
  formData.append('sessionId', chunk.sessionId);
  formData.append('chunkNumber', chunk.chunkNumber);
  formData.append('isFinal', chunk.isFinal || false);
  formData.append('mimeType', chunk.mimeType);
  
  const response = await fetch('/api/recording/transcribe-chunk', {
    method: 'POST',
    body: formData
  });
  
  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`);
  }
  
  return response.json();
}

// Message handler for clients
self.addEventListener('message', (event) => {
  console.log('[SW] Message received:', event.data);
  
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data.type === 'CLAIM_CLIENTS') {
    self.clients.claim();
  }
});

console.log('[SW] Service worker script loaded');

