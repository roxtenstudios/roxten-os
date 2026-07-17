'use client';

import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, Pause, Play, Square, RotateCcw, PhoneOff, Settings, Volume2 } from 'lucide-react';

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'paused' | 'interrupted' | 'offline';

interface VoiceContextProps {
  voiceState: VoiceState;
  startCall: (employeeId: string, employeeName: string, employeeRole: string, skipGreeting?: boolean) => void;
  endCall: () => void;
  isMuted: boolean;
  toggleMute: () => void;
  pauseSpeaking: () => void;
  resumeSpeaking: () => void;
  stopSpeaking: () => void;
  replayLastResponse: () => void;
  volume: number;
  setVolume: (vol: number) => void;
  activeEmployeeId: string | null;
  activeEmployeeName: string | null;
  activeEmployeeRole: string | null;
  handleVoiceInput: (text: string) => Promise<void>;
  simulateAIResponse: (text: string) => void;
  timeElapsed: number;
  history: {role: string, content: string}[];
}

const VoiceContext = createContext<VoiceContextProps | undefined>(undefined);

export const VoiceProvider = ({ children }: { children: ReactNode }) => {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [activeEmployeeId, setActiveEmployeeId] = useState<string | null>(null);
  const [activeEmployeeName, setActiveEmployeeName] = useState<string | null>(null);
  const [activeEmployeeRole, setActiveEmployeeRole] = useState<string | null>(null);
  const [lastResponse, setLastResponse] = useState<string>('');
  const [history, setHistory] = useState<{role: string, content: string}[]>([]);

  // Refs for stale closures in Web Speech API event listeners
  const voiceStateRef = useRef<VoiceState>('idle');
  const isMutedRef = useRef(false);
  const activeEmployeeIdRef = useRef<string | null>(null);
  const historyRef = useRef<{role: string, content: string}[]>([]);

  useEffect(() => {
    voiceStateRef.current = voiceState;
    isMutedRef.current = isMuted;
    activeEmployeeIdRef.current = activeEmployeeId;
    historyRef.current = history;
  }, [voiceState, isMuted, activeEmployeeId, history]);

  const synthRef = useRef<SpeechSynthesis | null>(null);
  const recognitionRef = useRef<any>(null);
  const [timeElapsed, setTimeElapsed] = useState(0);

  useEffect(() => {
    if ('speechSynthesis' in window) {
      synthRef.current = window.speechSynthesis;
    }
    
    // Load persisted volume
    const savedVolume = localStorage.getItem('rox_voice_volume');
    if (savedVolume) setVolume(parseFloat(savedVolume));
    
    // Keyboard shortcuts
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (voiceState !== 'idle' && !isMuted) {
           startListening();
        }
      }
      if (e.key === 'Escape') stopSpeaking();
      if (e.key === 'm' || e.key === 'M') toggleMute();
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
        if (voiceState !== 'idle') endCall();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [voiceState, isMuted]);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (voiceState === 'speaking' || voiceState === 'listening') {
      timer = setInterval(() => setTimeElapsed(prev => prev + 1), 1000);
    } else if (voiceState === 'idle') {
      setTimeElapsed(0);
    }
    return () => clearInterval(timer);
  }, [voiceState]);

  const updateVolume = (vol: number) => {
    setVolume(vol);
    localStorage.setItem('rox_voice_volume', vol.toString());
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const [handoverQueue, setHandoverQueue] = useState<any>(null);
  const [handoverTrigger, setHandoverTrigger] = useState(false);

  useEffect(() => {
    if (handoverTrigger && activeEmployeeId) {
       handleVoiceInput("The CEO just handed you the floor. Go ahead and speak.");
       setHandoverTrigger(false);
    }
  }, [activeEmployeeId, handoverTrigger]);

  const startListening = () => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) return;
    
    // We no longer cancel TTS on startListening natively, because startListening is meant to run continuously for full duplex.
    // Instead, we only transition state to listening if not currently speaking.
    if (!synthRef.current?.speaking) {
      setVoiceState('listening');
    }

    if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch(e) {}
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    recognitionRef.current = new SpeechRecognition();
    recognitionRef.current.continuous = false; // Set to false for faster silence detection (snappy response)
    recognitionRef.current.interimResults = true; // Get interim results to cut off AI instantly
    
    // Attempt to hint browser for AEC & Noise Suppression (non-standard but supported in some forks)
    recognitionRef.current.echoCancellation = true;
    recognitionRef.current.noiseSuppression = true;

    recognitionRef.current.onresult = (event: any) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }
      
      const currentText = finalTranscript || interimTranscript;
      
      if (currentText.trim()) {
        // FULL DUPLEX INTERRUPTION: Instantly cut off AI even on interim results!
        if (synthRef.current && synthRef.current.speaking) {
          synthRef.current.cancel();
          setVoiceState('interrupted');
        }
      }

      if (finalTranscript.trim()) {
        handleVoiceInput(finalTranscript);
      }
    };
    
    recognitionRef.current.onerror = (e: any) => {
      console.error('Speech recognition error', e);
      // Don't auto-restart immediately on error to avoid rapid looping, but restart after a delay
      if (voiceStateRef.current !== 'thinking' && voiceStateRef.current !== 'idle') {
         setTimeout(() => { if (!isMutedRef.current) startListening(); }, 1500);
      }
    };
    
    recognitionRef.current.onend = () => {
      // Always loop listening unless muted or call ended
      if (!isMutedRef.current && voiceStateRef.current !== 'idle') {
         startListening(); 
      }
    };

    if (!isMutedRef.current) {
      try { recognitionRef.current.start(); } catch (e) {}
    }
  };

  const handleVoiceInput = async (text: string) => {
    setVoiceState('thinking');
    
    const currentActiveEmployeeId = activeEmployeeIdRef.current;
    if (!currentActiveEmployeeId) return;

    // Optimistically update history with user input
    setHistory(prev => [...prev, { role: 'user', content: text }]);

    try {
      const res = await fetch(`/api/os/workforce/employee/${currentActiveEmployeeId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history: historyRef.current })
      });
      if (res.ok) {
        const data = await res.json();
        setLastResponse(data.text);
        setHistory(prev => [...prev, { role: 'assistant', content: data.text }]);
        
        if (data.handoverEmployee) {
          setHandoverQueue(data.handoverEmployee);
        }
        
        speakText(data.text);
      } else {
        setVoiceState('listening');
      }
    } catch (e) {
      console.error(e);
      setVoiceState('listening');
    }
  };

  const simulateAIResponse = (text: string) => {
      setLastResponse(text);
      setHistory(prev => [...prev, { role: 'assistant', content: text }]);
      speakText(text);
  };

  const speakText = (text: string) => {
    if (!synthRef.current) return;
    synthRef.current.cancel();
    
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.volume = volume;

    // Enhanced Provider Matching based on Web Speech API
    const voices = synthRef.current.getVoices();
    if (voices.length > 0) {
      const dbProfile = (window as any)._activeVoiceProfile || {};
      
      const isFemale = dbProfile.gender === 'Female' || activeEmployeeRole?.toLowerCase().includes('marketing') || activeEmployeeRole?.toLowerCase().includes('hr');
      const isBritish = dbProfile.accent?.includes('British') || activeEmployeeName?.toLowerCase().includes('jarvis');
      const isIndian = dbProfile.accent?.includes('Indian');
      const isAustralian = dbProfile.accent?.includes('Australian');

      const englishVoices = voices.filter(v => v.lang.startsWith('en'));
      const voicePool = englishVoices.length > 0 ? englishVoices : voices;
      
      let selectedVoice = voicePool.find(v => {
        const matchesGender = isFemale ? (v.name.includes('Female') || v.name.includes('Girl')) : (v.name.includes('Male') || v.name.includes('Guy'));
        let matchesAccent = true;
        if (isBritish) matchesAccent = v.lang.includes('GB');
        else if (isIndian) matchesAccent = v.lang.includes('IN');
        else if (isAustralian) matchesAccent = v.lang.includes('AU');
        else matchesAccent = v.lang.includes('US');
        
        return matchesGender && matchesAccent;
      });

      if (!selectedVoice) {
         // Fallback deterministic Hash if matching fails
         const idString = activeEmployeeId || 'default';
         let hash = 0;
         for (let i = 0; i < idString.length; i++) hash = idString.charCodeAt(i) + ((hash << 5) - hash);
         selectedVoice = voicePool[Math.abs(hash) % voicePool.length];
      }
      
      utterance.voice = selectedVoice;

      if (dbProfile.voicePitch) {
         utterance.pitch = parseFloat(dbProfile.voicePitch);
      } else {
         const pitchMod = (Math.abs(activeEmployeeId?.length || 0) % 40) / 100;
         utterance.pitch = 0.8 + pitchMod;
      }

      if (dbProfile.voiceSpeed) {
         utterance.rate = parseFloat(dbProfile.voiceSpeed);
      } else {
         const rateMod = ((Math.abs(activeEmployeeId?.length || 0) >> 1) % 20) / 100;
         utterance.rate = 0.9 + rateMod;
      }
    }
    
    utterance.onstart = () => {
      setVoiceState('speaking');
      // DO NOT ABORT RECOGNITION HERE. Keep the microphone hot for full-duplex interruptions.
    };
    
    utterance.onend = () => {
      if (handoverQueue) {
         startCall(handoverQueue.id, handoverQueue.name, handoverQueue.role);
         setHandoverTrigger(true);
         setHandoverQueue(null);
      } else if (voiceStateRef.current !== 'idle' && voiceStateRef.current !== 'paused' && voiceStateRef.current !== 'interrupted') {
        setVoiceState('listening');
        startListening();
      }
      (window as any)._currentUtterance = null;
    };
    
    // Prevent garbage collection mid-speech bug in Web Speech API
    (window as any)._currentUtterance = utterance;
    synthRef.current.speak(utterance);
  };

  const startCall = (employeeId: string, employeeName: string, employeeRole: string, skipGreeting: boolean = false) => {
    setActiveEmployeeId(employeeId);
    setActiveEmployeeName(employeeName);
    setActiveEmployeeRole(employeeRole);
    setHistory([]);
    setVoiceState('connecting');

    // Fetch the employee's custom voice profile from DB
    fetch(`/api/os/workforce/employee/${employeeId}`)
      .then(res => res.json())
      .then(data => {
        if (data.employee) {
          // Store voice settings in state or a ref to use in speakText
          (window as any)._activeVoiceProfile = {
            gender: data.employee.gender,
            accent: data.employee.accent,
            voiceSpeed: data.employee.voiceSpeed,
            voicePitch: data.employee.voicePitch
          };
        }
      })
      .catch(() => {});

    if (skipGreeting) {
       setVoiceState('thinking');
       return;
    }

    setTimeout(async () => {
      setVoiceState('thinking');
      try {
        const res = await fetch(`/api/os/workforce/employee/${employeeId}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: '[CEO has joined the call. Greet them naturally in 1 short sentence.]', history: [] })
        });
        if (res.ok) {
          const data = await res.json();
          setLastResponse(data.text);
          setHistory([{ role: 'assistant', content: data.text }]);
          speakText(data.text);
        } else {
          setVoiceState('listening');
          startListening();
        }
      } catch (e) {
        setVoiceState('listening');
        startListening();
      }
    }, 800);
  };

  const endCall = () => {
    setVoiceState('idle');
    setActiveEmployeeId(null);
    setActiveEmployeeName(null);
    setActiveEmployeeRole(null);
    setHistory([]);
    if (synthRef.current) synthRef.current.cancel();
    if (recognitionRef.current) recognitionRef.current.stop();
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
    if (!isMuted && recognitionRef.current) recognitionRef.current.stop();
    if (isMuted && voiceState !== 'idle') startListening();
  };

  const pauseSpeaking = () => {
    if (synthRef.current && synthRef.current.speaking) {
      synthRef.current.pause();
      setVoiceState('paused');
    }
  };

  const resumeSpeaking = () => {
    if (synthRef.current && synthRef.current.paused) {
      synthRef.current.resume();
      setVoiceState('speaking');
    }
  };

  const stopSpeaking = () => {
    if (synthRef.current) {
      synthRef.current.cancel();
      setVoiceState('interrupted');
      setTimeout(() => setVoiceState('listening'), 500);
    }
  };

  const replayLastResponse = () => {
    if (lastResponse) {
      speakText(lastResponse);
    }
  };

  return (
    <VoiceContext.Provider value={{
      voiceState, startCall, endCall, isMuted, toggleMute, 
      pauseSpeaking, resumeSpeaking, stopSpeaking, replayLastResponse,
      volume, setVolume, activeEmployeeId, activeEmployeeName, activeEmployeeRole, handleVoiceInput, simulateAIResponse,
      timeElapsed, history
    }}>
      {children}
      <VoiceControlBar />
    </VoiceContext.Provider>
  );
};

export const useVoice = () => {
  const context = useContext(VoiceContext);
  if (context === undefined) throw new Error('useVoice must be used within a VoiceProvider');
  return context;
};

// Global Floating Control Bar
const VoiceControlBar = () => {
  const { 
    voiceState, endCall, isMuted, toggleMute, pauseSpeaking, 
    resumeSpeaking, stopSpeaking, replayLastResponse, volume, setVolume,
    activeEmployeeName, activeEmployeeRole, timeElapsed
  } = useVoice();

  if (voiceState === 'idle') return null;

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <AnimatePresence>
      <motion.div 
        initial={{ y: 100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 100, opacity: 0 }}
        className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[9999] flex flex-col items-center gap-4"
      >
        {/* Status Indicator */}
        <div className="px-6 py-2 rounded-full bg-white backdrop-blur-xl border border-gray-200 flex items-center gap-3 shadow-2xl">
           <div className="flex items-center gap-2">
             {voiceState === 'speaking' ? (
                <div className="flex items-center gap-0.5 h-4 w-6">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <motion.div
                      key={i}
                      animate={{ height: ['20%', '100%', '20%'] }}
                      transition={{ duration: 0.5, repeat: Infinity, delay: i * 0.1 }}
                      className="w-1 bg-emerald-400 rounded-full"
                    />
                  ))}
                </div>
             ) : (
                <span className="relative flex h-2.5 w-2.5">
                  <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${voiceState === 'listening' ? 'bg-indigo-400' : voiceState === 'thinking' ? 'bg-purple-400' : 'bg-red-400'}`}></span>
                  <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${voiceState === 'listening' ? 'bg-indigo-500' : voiceState === 'thinking' ? 'bg-purple-500' : 'bg-red-500'}`}></span>
                </span>
             )}
             <span className="text-xs font-bold text-gray-900 uppercase tracking-widest min-w-[100px] flex items-center gap-2">
               {voiceState === 'speaking' && "AI Speaking"}
               {voiceState === 'listening' && "Listening..."}
               {voiceState === 'thinking' && "Thinking..."}
               {voiceState === 'paused' && "Paused"}
               {voiceState === 'interrupted' && "Interrupted"}
               {voiceState === 'connecting' && "Connecting..."}
               <span className="text-[10px] text-gray-500 ml-1 font-mono">{formatTime(timeElapsed)}</span>
             </span>
           </div>
           
           <div className="w-px h-4 bg-gray-50 mx-2" />
           
           <div className="flex flex-col">
             <span className="text-xs font-bold text-gray-900">{activeEmployeeName || 'JARVIS'}</span>
             <span className="text-[10px] text-gray-500">{activeEmployeeRole || 'System Intelligence'}</span>
           </div>
        </div>

        {/* Controls */}
        <div className="p-2 rounded-2xl bg-white backdrop-blur-2xl border border-gray-200 flex items-center gap-2 shadow-2xl">
          <button 
            onClick={toggleMute}
            className={`p-4 rounded-xl transition-all ${isMuted ? 'bg-red-500/20 text-red-500' : 'hover:bg-gray-50 text-gray-900'}`}
            title="Mute / Unmute (M)"
          >
            {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          </button>
          
          <div className="w-px h-8 bg-gray-50 mx-1" />

          {voiceState === 'speaking' ? (
            <button onClick={pauseSpeaking} className="p-4 rounded-xl hover:bg-gray-50 text-gray-900 transition-all" title="Pause">
              <Pause className="w-5 h-5" />
            </button>
          ) : voiceState === 'paused' ? (
             <button onClick={resumeSpeaking} className="p-4 rounded-xl hover:bg-gray-50 text-gray-900 transition-all" title="Resume">
              <Play className="w-5 h-5" />
            </button>
          ) : null}

          <button onClick={stopSpeaking} className="p-4 rounded-xl hover:bg-gray-50 text-gray-900 transition-all" title="Stop Speaking Instantly (Esc)">
            <Square className="w-5 h-5" />
          </button>
          
          <button onClick={replayLastResponse} className="p-4 rounded-xl hover:bg-gray-50 text-gray-900 transition-all" title="Replay Last Response">
            <RotateCcw className="w-5 h-5" />
          </button>

          <div className="w-px h-8 bg-gray-50 mx-1" />

          <button onClick={endCall} className="px-6 py-4 rounded-xl bg-red-600 hover:bg-red-700 text-gray-900 transition-all shadow-[0_0_15px_rgba(220,38,38,0.4)] flex items-center gap-2 font-bold text-sm">
            <PhoneOff className="w-4 h-4" /> End Call
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
};
