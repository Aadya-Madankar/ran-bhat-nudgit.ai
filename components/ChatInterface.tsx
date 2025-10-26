
import React, { useState, useRef, useEffect } from 'react';
import { streamTextResponse } from '../services/geminiService';
import type { Message } from '../types';
import { SendIcon, LinkIcon } from './icons';

const ChatHeader: React.FC<{ isTyping: boolean }> = ({ isTyping }) => (
    <div className="p-4 bg-brand-surface/90 border-b border-brand-bg-alt flex items-center space-x-4">
        <div className="relative">
            <div className="w-12 h-12 rounded-full bg-brand-primary flex items-center justify-center text-white font-bold text-xl font-serif">R</div>
            <span className="absolute bottom-0 right-0 block h-3.5 w-3.5 rounded-full bg-green-400 border-2 border-white"></span>
        </div>
        <div>
            <h2 className="text-lg font-bold text-brand-secondary">Rani Bhat</h2>
            <p className="text-sm text-brand-secondary/70 transition-opacity duration-300">{isTyping ? 'typing...' : 'Online'}</p>
        </div>
    </div>
);

const TypingIndicator: React.FC = () => (
    <div className="flex justify-start">
        <div className="w-fit max-w-xs p-4 rounded-2xl bg-brand-bg-alt text-brand-secondary rounded-bl-none flex items-center space-x-2">
            <div className="w-2 h-2 bg-brand-secondary/40 rounded-full animate-pulse"></div>
            <div className="w-2 h-2 bg-brand-secondary/40 rounded-full animate-pulse [animation-delay:0.2s]"></div>
            <div className="w-2 h-2 bg-brand-secondary/40 rounded-full animate-pulse [animation-delay:0.4s]"></div>
        </div>
    </div>
);


const ChatInterface: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'initial-greeting',
      text: "Hey! Rani here. 💕 So glad you slid into my DMs... What's the plan? 😉",
      sender: 'bot'
    }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [useSearch, setUseSearch] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const generationSessionIdRef = useRef(0);


  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const handleSend = async () => {
    if (!input.trim()) return;

    const currentSessionId = ++generationSessionIdRef.current;
    
    const newUserMessage: Message = { id: Date.now().toString(), text: input, sender: 'user' };
    const currentMessages = [...messages, newUserMessage];
    setMessages(currentMessages);
    setInput('');
    setIsLoading(true);

    const MAX_HISTORY_MESSAGES = 20;
    const history = currentMessages
        .filter(m => m.id !== 'initial-greeting')
        .slice(-MAX_HISTORY_MESSAGES)
        .map(m => ({
            role: m.sender === 'user' ? 'user' as const : 'model' as const,
            parts: [{ text: m.text }]
        }));
    
    let currentBotMessageId: string | null = null;
    let buffer = '';
    
    try {
        const responseStream = await streamTextResponse(newUserMessage.text, history, useSearch);
        const wait = (ms: number) => new Promise(res => setTimeout(res, ms));
        
        for await (const chunk of responseStream) {
            if (generationSessionIdRef.current !== currentSessionId) {
                // A new message was sent, so stop processing this stream
                setMessages(prev => prev.filter(msg => msg.id !== currentBotMessageId || msg.text.trim() !== ''));
                return;
            }

            buffer += chunk.textChunk || '';

            const commandRegex = /(\[REACT:[^\]]+\]|\[MSG_BREAK\])/;
            let parts = buffer.split(commandRegex).filter(Boolean);

            // The last part might be an incomplete command or text, so we keep it in the buffer
            if (parts.length > 1 && !commandRegex.test(parts[parts.length - 1])) {
                buffer = parts.pop() || '';
            } else if (parts.length > 0 && !commandRegex.test(parts[parts.length - 1])) {
                 buffer = parts.join(''); // Re-join if no full command found yet
                 parts = [];
            } else {
                buffer = '';
            }

            for (const part of parts) {
                if (part.startsWith('[REACT:')) {
                    const emoji = part.match(/\[REACT:([^\]]+)\]/)?.[1];
                    if (emoji) {
                        setMessages(prev => {
                            const updated = [...prev];
                            let lastUserMessageIndex = -1;
                            for (let i = updated.length - 1; i >= 0; i--) {
                                if (updated[i].sender === 'user') {
                                    lastUserMessageIndex = i;
                                    break;
                                }
                            }
                            if (lastUserMessageIndex !== -1 && !updated[lastUserMessageIndex].reaction) {
                                updated[lastUserMessageIndex] = { ...updated[lastUserMessageIndex], reaction: emoji };
                            }
                            return updated;
                        });
                    }
                } else if (part === '[MSG_BREAK]') {
                    currentBotMessageId = null;
                    await wait(Math.random() * 500 + 400); // Natural delay
                } else {
                    // It's a text part
                    const textPart = part;
                    if (!currentBotMessageId) {
                        currentBotMessageId = `${Date.now()}-bot`;
                        setMessages(prev => [...prev, { id: currentBotMessageId!, text: textPart, sender: 'bot', sources: [] }]);
                    } else {
                        setMessages(prev => prev.map(msg => msg.id === currentBotMessageId ? { ...msg, text: msg.text + textPart } : msg));
                    }
                }
            }

            if (chunk.sources) {
                if (!currentBotMessageId) {
                     currentBotMessageId = `${Date.now()}-bot-sources`;
                     setMessages(prev => [...prev, { id: currentBotMessageId!, text: '', sender: 'bot', sources: chunk.sources }]);
                } else {
                    setMessages(prev => prev.map(msg => {
                        if (msg.id === currentBotMessageId) {
                            const existingUris = new Set(msg.sources?.map(s => s.uri));
                            const newSources = chunk.sources!.filter(s => !existingUris.has(s.uri));
                            return { ...msg, sources: [...(msg.sources || []), ...newSources] };
                        }
                        return msg;
                    }));
                }
            }
        }
        
        // Handle any remaining text in the buffer after the stream ends
        if (buffer && generationSessionIdRef.current === currentSessionId) {
             if (!currentBotMessageId) {
                currentBotMessageId = `${Date.now()}-bot-final`;
                setMessages(prev => [...prev, { id: currentBotMessageId!, text: buffer, sender: 'bot', sources: [] }]);
            } else {
                setMessages(prev => prev.map(msg => msg.id === currentBotMessageId ? { ...msg, text: msg.text + buffer } : msg));
            }
        }

    } catch (error) {
        console.error("Error during streaming response:", error);
         if (currentBotMessageId) {
            setMessages(prev => prev.map(msg => msg.id === currentBotMessageId ? {...msg, text: msg.text + "\n\nOops, something went wrong."} : msg));
         } else {
            setMessages(prev => [...prev, {id: 'error-msg', text: "Oops, something went wrong. Please try again.", sender: 'bot'}]);
         }
    } finally {
         if (generationSessionIdRef.current === currentSessionId) {
            setIsLoading(false);
            // Final cleanup of any empty message bubbles
            setMessages(prev => prev.filter(msg => msg.text.trim() !== '' || (msg.sources && msg.sources.length > 0)));
        }
    }
  };

  return (
    <div className="flex flex-col h-[80vh] bg-brand-surface rounded-lg shadow-2xl overflow-hidden border border-brand-bg-alt">
        <ChatHeader isTyping={isLoading} />
        <div className="flex-grow p-6 overflow-y-auto space-y-6 bg-brand-bg-light">
        {messages.map((msg) => (
          // Only render the message if it has text content or sources
          (msg.text.trim() || (msg.sources && msg.sources.length > 0)) && (
            <div key={msg.id} className={`flex items-end gap-3 ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`relative w-fit max-w-lg p-3 px-4 rounded-2xl shadow-sm ${msg.sender === 'user' ? 'bg-brand-primary text-white rounded-br-none' : 'bg-brand-bg-alt text-brand-secondary rounded-bl-none'}`}>
                <p className="whitespace-pre-wrap">{msg.text.trim()}</p>
                {msg.sources && msg.sources.length > 0 && (
                    <div className={`mt-3 border-t pt-2 ${msg.text.trim() ? 'mt-3' : 'mt-0'} ${msg.sender === 'user' ? 'border-white/30' : 'border-brand-secondary/20'}`}>
                        <h4 className="text-xs font-bold mb-1 opacity-80">Sources:</h4>
                        <ul className="space-y-1">
                            {msg.sources.map((source, index) => (
                                <li key={index}>
                                    <a href={source.uri} target="_blank" rel="noopener noreferrer" className={`text-xs ${msg.sender === 'user' ? 'text-white/80 hover:underline' : 'text-brand-primary hover:underline'} flex items-center gap-1`}>
                                        <LinkIcon className="w-3 h-3"/>
                                        {source.title}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                 {msg.sender === 'user' && msg.reaction && (
                      <div className="absolute -bottom-3 -right-3 bg-brand-surface shadow-lg rounded-full w-7 h-7 flex items-center justify-center text-sm">
                          <span>{msg.reaction}</span>
                      </div>
                  )}
              </div>
            </div>
          )
        ))}
        {isLoading && <TypingIndicator />}
        <div ref={chatEndRef} />
      </div>
      <div className="p-4 bg-brand-surface/90 border-t border-brand-bg-alt">
        <div className="flex space-x-2 md:space-x-4 mb-3">
             <label className="flex items-center space-x-2 cursor-pointer text-sm text-brand-secondary/80">
                <input type="checkbox" checked={useSearch} onChange={(e) => setUseSearch(e.target.checked)} className="rounded text-brand-primary focus:ring-brand-primary-light" />
                <span>Search Web</span>
            </label>
        </div>
        <div className="flex items-center bg-brand-bg-alt rounded-lg">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Type your message..."
            className="flex-grow p-4 bg-transparent focus:outline-none text-brand-secondary"
          />
          <button onClick={handleSend} disabled={!input.trim()} className="p-4 text-brand-primary disabled:text-gray-400 transition-colors">
            <SendIcon className="w-6 h-6"/>
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatInterface;
