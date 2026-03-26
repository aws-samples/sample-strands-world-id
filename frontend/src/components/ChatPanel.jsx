import { useState, useEffect, useRef } from 'react';
import WorldIdVerify from './WorldIdVerify';

// Get API URL from runtime config or fallback to localhost for dev
const getApiUrl = () => {
  const url = (typeof window !== 'undefined' && window.APP_CONFIG?.API_URL)
    ? window.APP_CONFIG.API_URL
    : (import.meta.env.VITE_API_URL || 'http://localhost:8080');
  return url.replace(/\/+$/, '');
};

const API_URL = getApiUrl();

// Session management - sessions are created server-side
const SESSION_STORAGE_KEY = 'anycompany-session';

const getSavedSession = () => {
  try {
    const stored = localStorage.getItem(SESSION_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed.session_id && parsed.session_token) {
        return parsed;
      }
    }
  } catch {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  }
  return null;
};

const createServerSession = async () => {
  const response = await fetch(`${API_URL}/invocations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'create_session' }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();
  if (data.type === 'session_created' && data.session_id && data.session_token) {
    const session = {
      session_id: data.session_id,
      session_token: data.session_token,
    };
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    return session;
  }

  throw new Error('Unexpected response from session creation');
};

function ChatPanel() {
  const [messages, setMessages] = useState([
    {
      id: 'welcome',
      type: 'agent',
      content: "Hi! I'm your PC building assistant. Tell me about your needs and budget, and I'll help you build the perfect PC. What are you looking to do with your new computer?",
    },
  ]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [verificationRequired, setVerificationRequired] = useState(false);
  const [interruptData, setInterruptData] = useState(null);
  const [cart, setCart] = useState([]);
  const [session, setSession] = useState(getSavedSession);

  const messagesEndRef = useRef(null);
  const mountedRef = useRef(true);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Initialize session from server if none exists
  useEffect(() => {
    if (!session) {
      const initSession = async () => {
        try {
          const newSession = await createServerSession();
          if (mountedRef.current) {
            setSession(newSession);
          }
        } catch (error) {
          console.error('Failed to create session:', error);
          if (mountedRef.current) {
            setMessages((prev) => [
              ...prev,
              {
                id: Date.now().toString(),
                type: 'system',
                content: 'Error: Failed to connect to server. Please refresh the page.',
              },
            ]);
          }
        }
      };
      initSession();
    }
  }, [session]);

  const handleServerMessage = (data) => {
    if (!mountedRef.current) return;

    // Update cart from response
    if (data.cart !== undefined) {
      setCart(data.cart || []);
    }

    // Handle invalid session by clearing and re-creating
    if (data.type === 'error' && data.message === 'Invalid session credentials') {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      setSession(null);
      return;
    }

    switch (data.type) {
      case 'agent_message':
        if (data.content) {
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now().toString(),
              type: 'agent',
              content: data.content,
            },
          ]);
        }
        break;

      case 'interrupt':
        if (data.name === 'proof_of_human') {
          setVerificationRequired(true);
          setInterruptData(data);
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now().toString(),
              type: 'agent',
              content: data.reason,
            },
          ]);
        }
        break;

      case 'order_confirmed':
        setCart([]);
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            type: 'system',
            content: `Order #${data.order_id} confirmed! Total: $${data.total.toLocaleString()}`,
            isOrderConfirmation: true,
          },
        ]);
        break;

      case 'error':
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            type: 'system',
            content: `Error: ${data.message}`,
          },
        ]);
        break;

      default:
        console.log('Unknown message type:', data.type);
    }
  };

  const sendMessage = async (payload) => {
    if (!session) return;
    setIsLoading(true);
    try {
      const response = await fetch(`${API_URL}/invocations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          session_id: session.session_id,
          session_token: session.session_token,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      handleServerMessage(data);
    } catch (error) {
      console.error('Failed to send message:', error);
      handleServerMessage({
        type: 'error',
        message: 'Failed to connect to server. Please try again.',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!inputValue.trim() || isLoading || !session) return;

    const userMessage = {
      id: Date.now().toString(),
      type: 'user',
      content: inputValue.trim(),
    };

    setMessages((prev) => [...prev, userMessage]);

    sendMessage({
      type: 'message',
      content: inputValue.trim(),
    });

    setInputValue('');
  };

  const handleVerificationSuccess = (proof) => {
    setVerificationRequired(false);

    sendMessage({
      type: 'world_id_proof',
      proof: proof,
      interrupt_id: interruptData?.id,
    });

    setMessages((prev) => [
      ...prev,
      {
        id: Date.now().toString(),
        type: 'system',
        content: 'Human verification successful! Processing your order...',
      },
    ]);
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
          <h2>PC Building Assistant</h2>
        </div>
      </div>

      <div className="chat-messages">
        {messages.map((message) => (
          <div key={message.id} className={`message ${message.type}`}>
            {message.isOrderConfirmation ? (
              <div className="order-confirmation">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                <h4>Order Confirmed!</h4>
                <p>{message.content}</p>
              </div>
            ) : (
              message.content
            )}
          </div>
        ))}

        {cart.length > 0 && (
          <div className="cart-summary">
            <div className="cart-header">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="9" cy="21" r="1" />
                <circle cx="20" cy="21" r="1" />
                <path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6" />
              </svg>
              <strong>Your Cart</strong>
            </div>
            {cart.map((item, index) => (
              <div key={index} className="cart-item">
                <span className="cart-item-name">{item.name}</span>
                <span className="cart-item-price">${item.price.toLocaleString()}</span>
              </div>
            ))}
            <div className="cart-total">
              <span>Total:</span>
              <span>${cart.reduce((sum, item) => sum + item.price, 0).toLocaleString()}</span>
            </div>
          </div>
        )}

        {verificationRequired && (
          <WorldIdVerify
            reason={interruptData?.reason}
            onSuccess={handleVerificationSuccess}
            sessionId={session?.session_id}
            sessionToken={session?.session_token}
          />
        )}

        {isLoading && (
          <div className="typing-indicator">
            <span></span>
            <span></span>
            <span></span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        <form className="chat-input-form" onSubmit={handleSubmit}>
          <input
            type="text"
            className="chat-input"
            placeholder={!session ? "Connecting..." : isLoading ? "Thinking..." : "Ask me about PC parts, builds, or say 'checkout' to order..."}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            disabled={isLoading || verificationRequired || !session}
          />
          <button
            type="submit"
            className="chat-send-btn"
            disabled={!inputValue.trim() || isLoading || verificationRequired || !session}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}

export default ChatPanel;
