import { useState, useEffect } from 'react';
import { IDKitRequestWidget, orbLegacy } from '@worldcoin/idkit';

// Get config from runtime config or fallback for dev
const getConfig = () => {
  if (typeof window !== 'undefined' && window.APP_CONFIG) {
    return {
      appId: window.APP_CONFIG.WORLD_ID_APP_ID || '',
      action: window.APP_CONFIG.WORLD_ID_ACTION || 'checkout',
      rpId: window.APP_CONFIG.WORLD_ID_RP_ID || '',
    };
  }
  return {
    appId: import.meta.env.VITE_WORLD_ID_APP_ID || '',
    action: import.meta.env.VITE_WORLD_ID_ACTION || 'checkout',
    rpId: import.meta.env.VITE_WORLD_ID_RP_ID || '',
  };
};

// Get API URL from runtime config
const getApiUrl = () => {
  const url = (typeof window !== 'undefined' && window.APP_CONFIG?.API_URL)
    ? window.APP_CONFIG.API_URL
    : (import.meta.env.VITE_API_URL || 'http://localhost:8080');
  return url.replace(/\/+$/, '');
};

const config = getConfig();
const API_URL = getApiUrl();

function WorldIdVerify({ reason, onSuccess, sessionId, sessionToken }) {
  const [open, setOpen] = useState(false);
  const [rpContext, setRpContext] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchRpContext = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/invocations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'rp_signature',
          session_id: sessionId,
          session_token: sessionToken,
        }),
      });
      const data = await response.json();
      if (data.type === 'rp_context') {
        setRpContext({
          rp_id: data.rp_id,
          nonce: data.nonce,
          created_at: data.created_at,
          expires_at: data.expires_at,
          signature: data.signature,
        });
      } else {
        setError('Failed to get verification context');
      }
    } catch (err) {
      console.error('Failed to fetch RP context:', err);
      setError('Failed to connect to server');
    } finally {
      setLoading(false);
    }
  };

  const handleClick = async () => {
    await fetchRpContext();
    setOpen(true);
  };

  // Re-fetch rp_context if it's about to expire
  useEffect(() => {
    if (!rpContext) return;
    const now = Math.floor(Date.now() / 1000);
    if (rpContext.expires_at <= now) {
      setRpContext(null);
    }
  }, [rpContext]);

  return (
    <div className="verification-prompt">
      <p>{reason || 'Please verify you are human to complete this action.'}</p>

      {rpContext && (
        <IDKitRequestWidget
          open={open}
          onOpenChange={setOpen}
          app_id={config.appId}
          action={config.action}
          rp_context={rpContext}
          allow_legacy_proofs={true}
          preset={orbLegacy()}
          handleVerify={async (result) => {
            console.log('World ID proof received');
            onSuccess(result);
          }}
          onSuccess={(result) => {
            console.log('World ID verification complete');
          }}
          onError={(error) => {
            console.error('World ID verification error:', error);
            setError('Verification failed. Please try again.');
          }}
        />
      )}

      <button
        className="verify-btn"
        onClick={handleClick}
        disabled={loading}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
        {loading ? 'Loading...' : 'Verify with World ID'}
      </button>

      {error && <p className="verification-error">{error}</p>}
    </div>
  );
}

export default WorldIdVerify;
