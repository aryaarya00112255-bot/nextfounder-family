// Secure Netlify Function: creates a short-lived LiveKit room token for signed-in Firebase users.
// Required Netlify environment variables:
// LIVEKIT_API_KEY, LIVEKIT_API_SECRET, FIREBASE_API_KEY
const { AccessToken } = require('livekit-server-sdk');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };
  const out = (statusCode, data) => ({
    statusCode,
    headers,
    body: JSON.stringify(data)
  });

  if (event.httpMethod !== 'POST') {
    return out(405, { error: 'POST only' });
  }

  try {
    const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, FIREBASE_API_KEY } = process.env;
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !FIREBASE_API_KEY) {
      return out(500, { error: 'Server configuration missing' });
    }

    const body = JSON.parse(event.body || '{}');
    const { firebaseToken, roomName, participantName } = body;

    if (typeof firebaseToken !== 'string' || !firebaseToken) {
      return out(401, { error: 'Sign in required' });
    }
    if (
      typeof roomName !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(roomName) ||
      typeof participantName !== 'string' ||
      participantName.trim().length < 1 ||
      participantName.trim().length > 80
    ) {
      return out(400, { error: 'Invalid room or participant name' });
    }

    // Verify Firebase ID token server-side before issuing a LiveKit token.
    const verify = await fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' +
        encodeURIComponent(FIREBASE_API_KEY),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: firebaseToken })
      }
    );

    if (!verify.ok) {
      return out(401, { error: 'Invalid or expired sign-in' });
    }

    const verified = await verify.json();
    const uid = verified && verified.users && verified.users[0] && verified.users[0].localId;
    if (!uid) {
      return out(401, { error: 'Invalid sign-in' });
    }

    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: uid,
      name: participantName.trim(),
      ttl: '1h'
    });

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    });

    return out(200, { token: await token.toJwt() });
  } catch (error) {
    console.error('LiveKit token error:', error && error.message ? error.message : 'unknown');
    return out(500, { error: 'Could not create meeting token' });
  }
};
