import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, MicOff, Send, Volume2, VolumeX, Terminal, Cpu, Shield, Zap, Activity, Database, Lock, LogOut, Download, FileText, ChevronRight, User } from 'lucide-react';
import { streamChatWithAero, aeroSpeech, generateAeroImage } from '../services/geminiService';
import { auth, db, signInWithGoogle, logout, handleFirestoreError, OperationType } from '../lib/firebase';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { collection, query, where, onSnapshot, addDoc, serverTimestamp, doc, setDoc, Timestamp, orderBy } from 'firebase/firestore';
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';

declare global {
  interface Window {
    aistudio: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
    webkitAudioContext: typeof AudioContext;
  }
}

interface ArchiveDocument {
  id: string;
  folderId: string;
  title: string;
  content: string;
  timestamp: string;
  createdAt?: any;
}

interface ArchiveFolder {
  id: string;
  name: string;
  timestamp: string;
  createdAt?: any;
}

interface Message {
  role: 'user' | 'model';
  content: string;
  timestamp: string;
  type?: 'text' | 'image' | 'video' | 'archive_action';
  mediaUrl?: string;
  status?: 'pending' | 'completed' | 'error';
}

export default function AeroInterface() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [isBooted, setIsBooted] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [speechEnabled, setSpeechEnabled] = useState(true);
  const [uptime, setUptime] = useState('00:00:00');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [selectedMedia, setSelectedMedia] = useState<{ url: string, type: 'image' | 'video', content: string } | null>(null);
  
  // Archive State
  const [folders, setFolders] = useState<ArchiveFolder[]>([]);
  const [documents, setDocuments] = useState<ArchiveDocument[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string>('');
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const isPlayingRef = useRef(false);
  const nextAudioIndexRef = useRef(0);
  const audioMapRef = useRef<Map<number, AudioBuffer>>(new Map());
  const playIndexRef = useRef(0);
  const activeSourceRef = useRef<AudioBufferSourceNode | null>(null);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Firestore Listeners
  useEffect(() => {
    if (!user) {
      setFolders([]);
      setDocuments([]);
      return;
    }

    const foldersQuery = query(
      collection(db, 'folders'),
      where('ownerId', '==', user.uid)
    );

    const docsQuery = query(
      collection(db, 'documents'),
      where('ownerId', '==', user.uid)
    );

    const unsubscribeFolders = onSnapshot(foldersQuery, (snapshot) => {
      const folderList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ArchiveFolder));
      // Sort in-memory to avoids composite index requirement
      folderList.sort((a, b) => {
        const timeA = (a.createdAt as any)?.seconds || 0;
        const timeB = (b.createdAt as any)?.seconds || 0;
        return timeB - timeA;
      });
      setFolders(folderList);
    }, (error) => {
      console.error("AERO // Folder sync failure:", error);
      // Don't throw here to avoid crashing the whole UI
    });

    const unsubscribeDocs = onSnapshot(docsQuery, (snapshot) => {
      const docList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ArchiveDocument));
      docList.sort((a, b) => {
        const timeA = (a.createdAt as any)?.seconds || 0;
        const timeB = (b.createdAt as any)?.seconds || 0;
        return timeB - timeA;
      });
      setDocuments(docList);
    }, (error) => {
      console.error("AERO // Document sync failure:", error);
    });

    return () => {
      unsubscribeFolders();
      unsubscribeDocs();
    };
  }, [user]);

  // Uptime simulation
  useEffect(() => {
    const checkApiKey = async () => {
      if (window.aistudio) {
        const selected = await window.aistudio.hasSelectedApiKey();
        setHasApiKey(selected);
      }
    };
    checkApiKey();
    const interval = setInterval(checkApiKey, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!isBooted) return;
    const startTime = Date.now();
    const timer = setInterval(() => {
      const diff = Date.now() - startTime;
      const hours = Math.floor(diff / 3600000).toString().padStart(2, '0');
      const mins = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0');
      const secs = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
      setUptime(`${hours}:${mins}:${secs}`);
    }, 1000);
    return () => clearInterval(timer);
  }, [isBooted]);

  const bootSystem = async () => {
    setIsBooted(true);

    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }
    } catch (err) {
      console.warn("Audio hardware initialization deferred:", err);
    }
    
    const greeting = "Hi sir, What would u like to know";
    const timestamp = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const welcomeMessage: Message = { role: 'model', content: greeting, timestamp };
    
    setMessages([welcomeMessage]);
    queueAudioChunk(greeting);
  };


  const queueAudioChunk = async (text: string) => {
    if (!speechEnabled || !text.trim()) return;
    
    // Ensure context is active before queuing
    if (audioContextRef.current?.state === 'suspended') {
      audioContextRef.current.resume();
    }
    
    const currentIndex = nextAudioIndexRef.current++;
    
    try {
      const base64 = await aeroSpeech(text).catch(err => {
        console.warn(`AERO // Failed to generate neural vocal for chunk ${currentIndex}:`, err);
        // Put a null or marker in the map to indicate this chunk is "done" but empty
        audioMapRef.current.set(currentIndex, null as any);
        if (!isPlayingRef.current) processQueue();
        return null;
      });

      if (!base64) return;
      
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      const view = new DataView(bytes.buffer);
      const pcmData = new Int16Array(Math.floor(bytes.length / 2));
      for (let i = 0; i < pcmData.length; i++) {
        pcmData[i] = view.getInt16(i * 2, true);
      }
      
      const float32Data = new Float32Array(pcmData.length);
      for (let i = 0; i < pcmData.length; i++) {
        float32Data[i] = pcmData[i] / 32768;
      }

      const ctx = audioContextRef.current || new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContextRef.current = ctx;
      
      const audioBuffer = ctx.createBuffer(1, float32Data.length, 24000);
      audioBuffer.getChannelData(0).set(float32Data);
      
      audioMapRef.current.set(currentIndex, audioBuffer);
      
      if (!isPlayingRef.current) {
        processQueue();
      }
    } catch (error) {
      console.error("Audio queue error:", error);
      // Mark as done even on error to prevent queue stalls
      audioMapRef.current.set(currentIndex, null as any);
      if (!isPlayingRef.current) processQueue();
    }
  };

  const processQueue = async () => {
    // Check if the current required index exists in the map (even if null)
    if (!audioMapRef.current.has(playIndexRef.current)) {
      isPlayingRef.current = false;
      setIsSpeaking(false);
      return;
    }

    const nextBuffer = audioMapRef.current.get(playIndexRef.current);
    audioMapRef.current.delete(playIndexRef.current);
    playIndexRef.current++;

    if (!nextBuffer) {
      // It was a hole or failed chunk, move to next immediately
      processQueue();
      return;
    }

    isPlayingRef.current = true;
    setIsSpeaking(true);

    const source = audioContextRef.current!.createBufferSource();
    source.buffer = nextBuffer;
    source.connect(audioContextRef.current!.destination);
    source.onended = () => {
      if (activeSourceRef.current === source) {
        activeSourceRef.current = null;
      }
      processQueue();
    };
    activeSourceRef.current = source;
    source.start();
  };

  // Initialize Speech Recognition
  useEffect(() => {
    if (!isBooted) return;
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.interimResults = false;
      recognitionRef.current.lang = 'en-US';

      recognitionRef.current.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setInput(transcript);
        handleSend(transcript);
        setIsListening(false);
      };

      recognitionRef.current.onerror = (event: any) => {
        if (event.error === 'no-speech') {
          const timestamp = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
          const errorMsg = "Sir, I didn't catch that. No vocal input detected.";
          setMessages(prev => [...prev, { role: 'model', content: errorMsg, timestamp }]);
          queueAudioChunk(errorMsg);
        }
        setIsListening(false);
      };

      recognitionRef.current.onend = () => {
        setIsListening(false);
      };
    }
  }, [isBooted]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const toggleListening = () => {
    if (isListening) {
      recognitionRef.current?.stop();
    } else {
      recognitionRef.current?.start();
      setIsListening(true);
    }
  };

  const handleSend = async (text: string = input) => {
    if (!text.trim() || isProcessing) return;

    // Reset audio indexing for new interaction
    nextAudioIndexRef.current = 0;
    playIndexRef.current = 0;
    audioMapRef.current.clear();

    // Stop and clear any currently playing audio source
    if (activeSourceRef.current) {
      try {
        activeSourceRef.current.stop();
      } catch (e) {
        // Already stopped or not applicable
      }
      activeSourceRef.current = null;
    }

    const timestamp = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setMessages(prev => [...prev, { role: 'user', content: text, timestamp }]);
    setInput('');
    setIsProcessing(true);

    try {
      const history = messages.map(m => ({
        role: m.role,
        parts: [{ text: m.content }]
      }));

      let fullResponse = "";
      let currentChunk = "";
      
      const stream = streamChatWithAero(text, history);
      const modelTimestamp = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      
      // Initial empty model message
      setMessages(prev => [...prev, { role: 'model', content: "", timestamp: modelTimestamp, type: 'text' }]);

      for await (const message of stream) {
        if (message.type === 'text') {
          fullResponse += message.content;
          currentChunk += message.content;

          setMessages(prev => {
            const next = [...prev];
            const lastMessage = next[next.length - 1];
            if (lastMessage.role === 'model' && lastMessage.type === 'text') {
               lastMessage.content = fullResponse;
            }
            return next;
          });

          if (/[.!?](\s|$)/.test(currentChunk) || currentChunk.length > 100) {
            queueAudioChunk(currentChunk.trim());
            currentChunk = "";
          }
        } else if (message.type === 'function_call') {
          const { name, args } = message.call;
          
          if (name === 'generate_image') {
            const imageArgs = args as { prompt: string, aspectRatio?: string };

            const imageMsg: Message = {
              role: 'model',
              content: `Generating neural visualization: "${imageArgs.prompt}"...`,
              timestamp: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
              type: 'image',
              status: 'pending'
            };
            setMessages(prev => [...prev, imageMsg]);
            
            generateAeroImage(imageArgs.prompt, imageArgs.aspectRatio).then(url => {
               setMessages(prev => prev.map(m => 
                 (m.type === 'image' && m.status === 'pending' && m.content.includes(imageArgs.prompt)) 
                 ? { ...m, mediaUrl: url, status: 'completed', content: `Neural visualization complete: ${imageArgs.prompt}` } 
                 : m
               ));
               if (speechEnabled) queueAudioChunk("Visualization complete, sir.");
            }).catch(err => {
               console.error("Image generation failed:", err);
               setMessages(prev => prev.map(m => 
                 (m.type === 'image' && m.status === 'pending' && m.content.includes(imageArgs.prompt)) 
                 ? { ...m, status: 'error', content: `VISUALIZATION FAILURE: ${err.message}` } 
                 : m
               ));
               if (speechEnabled) queueAudioChunk("Sir, visualization subsystems reported a failure.");
            });
          } else if (name === 'create_folder') {
            if (!user) {
              queueAudioChunk("Sir, archival requires a verified identity link. Please initialize the matrix first.");
              return;
            }
            const folderArgs = args as { name: string };
            const folderId = Math.random().toString(36).substr(2, 9);
            
            setDoc(doc(db, 'folders', folderId), {
              id: folderId,
              name: folderArgs.name,
              ownerId: user.uid,
              createdAt: serverTimestamp(),
              timestamp: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
            }).then(() => {
              setMessages(prev => [...prev, {
                role: 'model',
                content: `ARCHIVE_CMD: New directory [${folderArgs.name}] initialized in neural matrix. Key: ${folderId}`,
                timestamp: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                type: 'archive_action'
              }]);
              if (speechEnabled) queueAudioChunk(`Archive directory ${folderArgs.name} initialized, sir.`);
            }).catch(err => {
              console.error("Folder creation failed:", err);
              handleFirestoreError(err, OperationType.CREATE, 'folders');
            });

          } else if (name === 'add_document') {
            if (!user) {
              queueAudioChunk("Sir, identity link is required for archive commits.");
              return;
            }
            const docArgs = args as { folderId: string, title: string, content: string };
            const docId = Math.random().toString(36).substr(2, 9);
            
            setDoc(doc(db, 'documents', docId), {
              id: docId,
              folderId: docArgs.folderId,
              ownerId: user.uid,
              title: docArgs.title,
              content: docArgs.content,
              createdAt: serverTimestamp(),
              timestamp: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
            }).then(() => {
              setMessages(prev => [...prev, {
                role: 'model',
                content: `DOC_ARCHIVED: [${docArgs.title}] successfully committed to archival node ${docArgs.folderId}.`,
                timestamp: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                type: 'archive_action'
              }]);
              if (speechEnabled) queueAudioChunk(`Document ${docArgs.title} has been committed to the archives.`);
            }).catch(err => {
              console.error("Document commit failed:", err);
              handleFirestoreError(err, OperationType.CREATE, 'documents');
            });
          } else if (name === 'list_folders') {
            if (!user) {
              queueAudioChunk("Sir, remote archive access requires identity verification.");
              return;
            }
            const folderList = folders.map(f => `${f.name} (ID: ${f.id})`).join(', ');
            setMessages(prev => [...prev, {
              role: 'model',
              content: `MAPPING ARCHIVES: [${folderList || 'Empty'}]`,
              timestamp: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
              type: 'archive_action'
            }]);
            if (speechEnabled) queueAudioChunk(folderList ? "Archives mapped, sir." : "Neural archives are currently empty.");
          }
        }
      }

      if (currentChunk.trim()) {
        queueAudioChunk(currentChunk.trim());
      }

    } catch (error: any) {
      console.error("AERO // Processing Interruption:", error);
      const errTimestamp = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      
      let errorDetail = error.message || "Unknown neural fault";
      if (errorDetail.includes("VITE_GEMINI_API_KEY")) {
        errorDetail = "Neural API key missing from configuration.";
      } else if (errorDetail.includes("429") || errorDetail.includes("quota")) {
        errorDetail = "Neural bandwidth exceeded (Rate limit). Please wait for node reset.";
      }
      
      const errorMsg = `CRITICAL FAULT: [${errorDetail}]`;
      setMessages(prev => [...prev, { 
        role: 'model', 
        content: errorMsg, 
        timestamp: errTimestamp,
        status: 'error'
      }]);
      queueAudioChunk("Sir, logic drive failure encountered. System requires diagnostic.");
    } finally {
      setIsProcessing(false);
    }
  };

  const exportToPDF = (doc: ArchiveDocument) => {
    const pdf = new jsPDF();
    
    // Aesthetic Styling for PDF
    pdf.setFillColor(5, 8, 10);
    pdf.rect(0, 0, 210, 297, 'F');
    
    pdf.setTextColor(0, 242, 255);
    pdf.setFontSize(24);
    pdf.text("AERO // NEURAL ARCHIVE", 20, 30);
    
    pdf.setDrawColor(0, 242, 255);
    pdf.line(20, 35, 190, 35);
    
    pdf.setFontSize(14);
    pdf.setTextColor(255, 255, 255);
    pdf.text(`TITLE: ${doc.title}`, 20, 50);
    pdf.text(`TIMESTAMP: ${doc.timestamp}`, 20, 60);
    pdf.text(`NODE_ID: ${doc.id}`, 20, 70);
    
    pdf.setFontSize(12);
    pdf.setTextColor(200, 200, 200);
    const splitText = pdf.splitTextToSize(doc.content, 170);
    pdf.text(splitText, 20, 90);
    
    pdf.setFontSize(8);
    pdf.setTextColor(0, 242, 255);
    pdf.text("SCANLINE_VERIFIED // AES-512 ENCRYPTED DATA", 20, 280);
    
    pdf.save(`aero_archive_${doc.title.replace(/\s+/g, '_')}.pdf`);
  };

  const handleLogin = async () => {
    try {
      await signInWithGoogle();
      queueAudioChunk("Authentication successful, sir. Systems are online.");
    } catch (err: any) {
      console.error("Firebase Login Error:", err);
      const errorCode = err.code || 'unknown';
      const errorMessage = err.message || 'An unknown error occurred during identity verification.';
      
      if (errorCode === 'auth/unauthorized-domain') {
        alert(`Domain Not Authorized: ${window.location.hostname} is not in the authorized domains list in your Firebase Console. Please add it under Authentication > Settings > Authorized Domains.`);
      } else if (errorCode === 'auth/invalid-api-key') {
        alert("Invalid API Key: The Firebase API key provided is invalid or restricted. Please check your environment variables.");
      } else if (errorCode === 'auth/operation-not-allowed') {
        alert("Operation Not Allowed: Google Sign-In is not enabled in your Firebase Project. Please enable it in the Firebase Console under Authentication > Sign-in method.");
      } else {
        alert(`Neural Link Failed [${errorCode}]: ${errorMessage}`);
      }
    }
  };

  if (authLoading) {
    return (
      <div className="h-screen w-screen bg-black flex items-center justify-center">
        <motion.div 
          animate={{ rotate: 360 }}
          transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
          className="w-16 h-16 border-4 border-accent border-t-transparent rounded-full shadow-[0_0_20px_rgba(0,242,255,0.4)]"
        />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-screen w-screen bg-[#05080a] flex flex-col items-center justify-center p-6 relative overflow-hidden">
        <div className="grid-overlay opacity-30" />
        <div className="scanline-effect" />
        
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="relative z-10 flex flex-col items-center text-center gap-10 max-w-md"
        >
          <div className="w-32 h-32 rounded-full border-2 border-accent/30 flex items-center justify-center relative bg-accent/5">
             <Shield className="w-16 h-16 text-accent animate-pulse" />
             <motion.div 
              animate={{ rotate: 360 }}
              transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
              className="absolute inset-0 border border-dashed border-accent/20 rounded-full"
             />
          </div>

          <div className="space-y-4">
            <h1 className="text-4xl font-bold tracking-[0.5em] text-accent text-shadow-glow">AERO</h1>
            <p className="text-xs tracking-[0.3em] opacity-40 uppercase">Advanced Neural Interface // OS_V.4.2</p>
          </div>

          <p className="text-[11px] leading-relaxed tracking-widest opacity-60">
            SECURE ACCESS REQUIRED. PLEASE LOG IN TO INITIALIZE YOUR NEURAL VAULT AND ARCHIVE SYSTEMS.
          </p>

          <button 
            onClick={handleLogin}
            className="w-full py-4 bg-accent/10 border border-accent/40 rounded flex items-center justify-center gap-4 hover:bg-accent hover:text-black transition-all group relative overflow-hidden"
          >
             <div className="absolute inset-x-0 bottom-0 h-1 bg-accent/50 group-hover:h-full transition-all duration-300 -z-1" />
             <User className="w-5 h-5" />
             <span className="font-bold tracking-[0.4em] uppercase text-sm">Initialize Identity Link</span>
          </button>
          
          <div className="flex gap-4 opacity-20 text-[8px] tracking-[0.5em] uppercase mt-10">
            <span>Auth_AES512</span>
            <span>Vault_Alpha</span>
            <span>Nodes_Online</span>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="relative h-screen w-screen bg-[#05080a] text-accent/80 font-mono flex flex-col overflow-hidden">
      <AnimatePresence>
        {!isBooted && (
          <motion.div 
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 1.1, filter: 'blur(20px)' }}
            transition={{ duration: 1, ease: "easeIn" }}
            className="fixed inset-0 z-[1000] bg-black flex flex-col items-center justify-center p-10 overflow-hidden"
          >
            <div className="grid-overlay opacity-20" />
            
            {/* Ambient Hud Circles */}
            <motion.div 
                animate={{ rotate: 360 }}
                transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                className="absolute w-[600px] h-[600px] border border-accent/5 rounded-full"
            />
            <motion.div 
                animate={{ rotate: -360 }}
                transition={{ duration: 30, repeat: Infinity, ease: "linear" }}
                className="absolute w-[500px] h-[500px] border border-dashed border-accent/10 rounded-full"
            />

            <motion.div 
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 1, ease: "easeOut" }}
                className="relative z-[1001] flex flex-col items-center"
            >
                <div className="relative w-64 h-64 mb-16 flex items-center justify-center">
                   {/* Deep Core Pulse */}
                   <motion.div 
                    animate={{ 
                        scale: [1, 1.2, 1],
                        opacity: [0.1, 0.3, 0.1]
                    }}
                    transition={{ duration: 3, repeat: Infinity }}
                    className="absolute inset-0 bg-accent rounded-full blur-[60px]"
                   />
                   
                   <motion.div 
                    animate={{ rotate: 360 }}
                    transition={{ duration: 5, repeat: Infinity, ease: "linear" }}
                    className="absolute inset-0 border-t-2 border-r-2 border-accent shadow-[0_0_30px_rgba(0,242,255,0.4)] rounded-full" 
                   />
                   <motion.div 
                    animate={{ rotate: -360 }}
                    transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
                    className="absolute inset-4 border-b-2 border-l-2 border-accent/30 rounded-full" 
                   />
                   
                   <div className="text-accent flex flex-col items-center z-10">
                    <motion.div
                        animate={{ opacity: [0.4, 1, 0.4] }}
                        transition={{ duration: 2, repeat: Infinity }}
                    >
                        <Shield className="w-20 h-20 mb-4" />
                    </motion.div>
                    <span className="text-2xl font-bold tracking-[0.8em] ml-[0.8em]">AERO</span>
                   </div>
                </div>
                
                <motion.button 
                  whileHover={{ scale: 1.05, backgroundColor: 'rgba(0, 242, 255, 0.2)' }}
                  whileTap={{ scale: 0.95 }}
                  onClick={bootSystem}
                  className="relative z-[1002] px-16 py-6 bg-accent/5 border-2 border-accent/40 rounded-full text-accent font-bold tracking-[0.4em] transition-all shadow-[0_0_20px_rgba(0,242,255,0.1)] hover:shadow-[0_0_50px_rgba(0,242,255,0.5)] cursor-pointer group overflow-hidden"
                >
                  <span className="relative z-10">INITIATE BOOT</span>
                  <motion.div 
                    className="absolute inset-0 bg-accent translate-y-full group-hover:translate-y-0 transition-transform duration-300 opacity-20"
                  />
                </motion.button>
                
                <div className="mt-16 space-y-3 opacity-30 text-[10px] tracking-[0.4em] text-center uppercase">
                    <motion.div
                        animate={{ opacity: [0.2, 1, 0.2] }}
                        transition={{ duration: 2, repeat: Infinity }}
                    >
                        HANDSHAKE: [ SECURE ]
                    </motion.div>
                    <div>OS_KRNL // VER_4.2.0_ALPHA</div>
                    <div>NEURAL_LINK: STANDBY</div>
                </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Background FX */}
      <div className="grid-overlay" />
      <div className="scanline-effect" />
      
      {/* Header */}
      <header className="h-20 flex items-center justify-between px-10 border-b border-accent/20 bg-black/30 z-50 backdrop-blur-sm">
        <div className="text-accent font-bold tracking-[0.3em] flex items-center gap-4">
          <span className="text-xl shadow-[0_0_10px_#00f2ff]">AERO // OS_V.4.2</span>
        </div>
        
        <div className="hidden md:flex items-center gap-8 text-[11px] tracking-widest opacity-60">
          <div className="flex items-center gap-2">
            <Activity className="w-3 h-3" />
            <span>UPTIME: {uptime}</span>
          </div>
          <div className="flex items-center gap-2">
            <Zap className="w-3 h-3" />
            <span>LATENCY: 0.002ms</span>
          </div>
          <div className="flex items-center gap-2">
            <Lock className="w-3 h-3" />
            <span>ENCRYPTION: AES-512</span>
          </div>
          <div className="flex items-center gap-2 text-green-400">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span>SYSTEMS CLEAR</span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="hidden lg:flex flex-col items-end mr-2">
             <span className="text-[10px] font-bold text-accent uppercase tracking-widest">{user?.displayName || user?.email?.split('@')[0]}</span>
             <span className="text-[8px] opacity-40 uppercase tracking-tighter">Identity_Verified</span>
          </div>
          
          <button 
            onClick={() => logout()}
            className="p-2 border border-accent/30 rounded bg-accent/5 hover:bg-red-500/20 hover:border-red-500/40 transition-all text-accent hover:text-red-500"
            title="Terminate Link"
          >
            <LogOut className="w-4 h-4" />
          </button>

          {!hasApiKey && (
            <button 
              onClick={() => window.aistudio.openSelectKey()}
              className="hidden lg:flex items-center gap-2 px-4 py-1.5 bg-red-500/10 border border-red-500/30 text-red-500 text-[10px] uppercase font-bold tracking-widest hover:bg-red-500 hover:text-white transition-all rounded animate-pulse shadow-[0_0_15px_rgba(239,68,68,0.2)]"
            >
              <Lock className="w-3 h-3" />
              Initialize High-Tier Matrix
            </button>
          )}
          <button 
            onClick={() => setSpeechEnabled(!speechEnabled)}
            className="p-2 border border-accent/30 rounded bg-accent/5 hover:bg-accent/10 transition-all font-mono"
          >
            {speechEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4 text-red-500" />}
          </button>
          <div className="p-2 border border-accent/30 rounded bg-accent/5">
            <Shield className="w-4 h-4" />
          </div>
        </div>
      </header>

      {/* Main Grid */}
      <main className="flex-1 grid grid-cols-1 md:grid-cols-[280px_1fr_280px] gap-6 p-6 overflow-hidden z-10">
        
        {/* Left: Neural Archives & Diagnostics */}
        <aside className="hidden md:flex flex-col gap-6 overflow-hidden">
          <div className="flex-1 border border-accent/20 rounded bg-accent/[0.03] p-5 backdrop-blur-md flex flex-col overflow-hidden">
            <h2 className="text-[10px] uppercase font-bold tracking-[0.2em] mb-6 border-l-2 border-accent pl-3">Neural Archives</h2>
            
            <div className="flex-1 overflow-y-auto space-y-4 pr-2 scrollbar-thin scrollbar-thumb-accent/10">
              {folders.map(folder => (
                <div key={folder.id} className="space-y-2">
                   <div 
                    onClick={() => setSelectedFolderId(folder.id === selectedFolderId ? '' : folder.id)}
                    className={`flex items-center gap-3 p-2 rounded cursor-pointer transition-all border ${
                      selectedFolderId === folder.id ? 'bg-accent/10 border-accent/40 text-accent' : 'bg-white/5 border-transparent hover:border-white/10'
                    }`}
                   >
                     <Database className={`w-3.5 h-3.5 ${selectedFolderId === folder.id ? 'animate-pulse' : 'opacity-40'}`} />
                     <span className="text-[11px] font-bold tracking-widest truncate">{folder.name}</span>
                   </div>
                   
                   <AnimatePresence>
                     {selectedFolderId === folder.id && (
                       <motion.div 
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden pl-4 space-y-2"
                       >
                         {documents.filter(d => d.folderId === folder.id).map(doc => (
                           <div 
                            key={doc.id}
                            className="p-2 bg-accent/5 border border-accent/10 rounded group cursor-auto hover:bg-accent/10 transition-all relative overflow-hidden"
                           >
                             <div 
                                className="cursor-help"
                                onClick={() => {
                                  const timestamp = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                                  setMessages(prev => [...prev, {
                                    role: 'model',
                                    content: `Displaying archived document: ${doc.title}\n\n${doc.content}`,
                                    timestamp
                                  }]);
                                }}
                             >
                               <div className="flex items-center gap-2 mb-1">
                                  <Terminal className="w-3 h-3 text-accent" />
                                  <span className="text-[10px] font-bold text-accent/80 truncate">{doc.title}</span>
                               </div>
                               <div className="text-[9px] opacity-40 truncate">{doc.content.slice(0, 30)}...</div>
                             </div>

                             <button 
                               onClick={(e) => {
                                 e.stopPropagation();
                                 exportToPDF(doc);
                               }}
                               className="absolute right-1 bottom-1 p-1 rounded bg-accent/10 hover:bg-accent hover:text-black transition-all opacity-0 group-hover:opacity-100"
                               title="Download PDF"
                             >
                               <Download className="w-2.5 h-2.5" />
                             </button>
                           </div>
                         ))}
                         {documents.filter(d => d.folderId === folder.id).length === 0 && (
                           <div className="text-[9px] opacity-30 italic py-2">No data entries found in this node.</div>
                         )}
                       </motion.div>
                     )}
                   </AnimatePresence>
                </div>
              ))}
            </div>

            <div className="mt-6 pt-6 border-t border-accent/10">
              <h2 className="text-[10px] uppercase font-bold tracking-[0.2em] mb-4 border-l-2 border-accent pl-3">System Load</h2>
              <div className="space-y-4">
                {[
                  { label: 'Neural Matrix', val: 14.2 },
                  { label: 'Archive Index', val: documents.length * 5 }
                ].map((stat, i) => (
                  <div key={i} className="space-y-1.5">
                    <div className="flex justify-between text-[10px] opacity-60 uppercase">
                      <span>{stat.label}</span>
                      <span className="text-white">{stat.val.toFixed(1)}%</span>
                    </div>
                    <div className="h-1 bg-accent/10 w-full relative">
                      <motion.div 
                        className="absolute inset-y-0 left-0 bg-accent shadow-[0_0_8px_#00f2ff]"
                        initial={{ width: 0 }}
                        animate={{ width: `${stat.val}%` }}
                        transition={{ duration: 1 }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </aside>

        {/* Center: Core & Main Visual Display */}
        <section className="flex flex-col gap-6 relative min-h-0">
          <div className="flex-1 flex flex-col items-center justify-center border border-accent/10 bg-accent/[0.01] rounded relative overflow-hidden">
            {/* Background Core (De-emphasized when media is present) */}
            <div className={`transition-all duration-1000 ${selectedMedia || (messages.findLast(m => m.mediaUrl)) ? 'scale-50 opacity-20 blur-sm absolute' : 'relative'}`}>
              <div className="relative group cursor-pointer">
                {/* Aero Core Circle */}
                <div className="w-[300px] h-[300px] rounded-full border border-accent/30 flex items-center justify-center relative shadow-[inset_0_0_50px_rgba(0,242,255,0.1),0_0_30px_rgba(0,242,255,0.05)]">
                  <div className="w-[240px] h-[240px] rounded-full border-2 border-dashed border-accent/20 flex items-center justify-center">
                    <motion.div 
                      animate={{ 
                        scale: isSpeaking ? [1, 1.15, 1] : 1,
                        opacity: isSpeaking ? [0.6, 1, 0.6] : 0.6
                      }}
                      transition={{ duration: 0.5, repeat: Infinity }}
                      className="w-[180px] h-[180px] rounded-full bg-radial from-accent/20 to-transparent border border-accent/50 flex items-center justify-center shadow-[0_0_40px_rgba(0,242,255,0.4)]"
                    >
                      <div className="flex items-end gap-1.5 h-12">
                        {[1, 2, 3, 4, 3, 2, 1, 2, 3, 4].map((h, i) => (
                          <motion.div 
                            key={i}
                            animate={{ 
                              height: isSpeaking || isProcessing ? ['20%', '100%', '20%'] : '15%'
                            }}
                            transition={{ 
                              duration: 0.4, 
                              repeat: Infinity, 
                              delay: i * 0.05,
                              ease: "easeInOut"
                            }}
                            className="w-1 bg-accent shadow-[0_0_5px_#00f2ff]"
                          />
                        ))}
                      </div>
                    </motion.div>
                  </div>
                  <motion.div 
                    animate={{ rotate: 360 }}
                    transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                    className="absolute inset-0 border border-accent/10 rounded-full border-t-accent/40"
                  />
                </div>

                <div className="absolute -bottom-20 left-1/2 -translate-x-1/2 text-center w-full">
                  <h3 className="text-2xl font-bold tracking-[0.4em] text-accent text-shadow-glow">
                    {isProcessing ? 'PROCESSING...' : 'AERO ONLINE'}
                  </h3>
                </div>
              </div>
            </div>

            {/* Active Media Display Layer */}
            <AnimatePresence mode="wait">
              {(selectedMedia || messages.findLast(m => m.status === 'completed' && m.mediaUrl)) && (
                <motion.div 
                  key={selectedMedia?.url || messages.findLast(m => m.mediaUrl)?.mediaUrl}
                  initial={{ opacity: 0, scale: 1.1, y: 20 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9, y: -20 }}
                  className="absolute inset-0 flex flex-col items-center justify-center p-6 bg-black/40 backdrop-blur-sm"
                >
                  <div className="w-full max-w-5xl h-full flex flex-col gap-4">
                    <div className="flex items-center justify-between border-b border-accent/20 pb-2">
                       <div className="flex items-center gap-3">
                          <Activity className="w-4 h-4 text-accent animate-pulse" />
                          <span className="text-[10px] uppercase font-bold tracking-[0.4em] text-accent">Active Neural Display // {selectedMedia?.type || messages.findLast(m => m.mediaUrl)?.type}</span>
                       </div>
                       <button 
                         onClick={() => setSelectedMedia(null)}
                         className="text-[9px] uppercase tracking-widest text-accent/50 hover:text-accent transition-colors"
                       >
                         Dismiss Sequence
                       </button>
                    </div>
                    
                    <div className="flex-1 min-h-0 bg-black flex items-center justify-center rounded border border-accent/10 overflow-hidden shadow-[0_0_50px_rgba(0,242,255,0.1)] relative group">
                        <img 
                          src={selectedMedia?.url || messages.findLast(m => m.mediaUrl)?.mediaUrl} 
                          alt="Generated Sequence"
                          className="w-full h-full object-contain"
                          referrerPolicy="no-referrer"
                        />
                      
                      {!selectedMedia && (
                        <div 
                          className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center cursor-pointer"
                          onClick={() => {
                            const last = messages.findLast(m => m.status === 'completed' && m.mediaUrl);
                            if (last) setSelectedMedia({ url: last.mediaUrl!, type: last.type!, content: last.content });
                          }}
                        >
                           <div className="bg-accent/20 backdrop-blur-md px-8 py-3 border border-accent/50 rounded-full text-accent font-bold tracking-[0.4em] text-[10px] uppercase">
                             Expand Sequence Matrix
                           </div>
                        </div>
                      )}
                    </div>
                    
                    <div className="text-[10px] tracking-widest text-white/40 italic uppercase text-center border-t border-accent/10 pt-2">
                      {selectedMedia?.content || messages.findLast(m => m.mediaUrl)?.content}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </section>

        {/* Right: Execution Log / Chat Feed */}
        <aside className="flex flex-col border border-accent/20 rounded bg-accent/[0.03] backdrop-blur-md min-h-0">
          <div className="p-5 border-b border-accent/10 flex justify-between items-center">
            <h2 className="text-[10px] uppercase font-bold tracking-[0.2em] border-l-2 border-accent pl-3">Execution Log</h2>
            <div className="text-[10px] opacity-40">NODE_ID: 808</div>
          </div>
          
          <div 
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-4 space-y-4 scroll-smooth scrollbar-thin scrollbar-thumb-accent/20"
          >
            {messages.length === 0 && (
              <div className="space-y-2 opacity-30 text-[11px]">
                <div>[09:14:22] Initializing Core...</div>
                <div>[09:14:23] Secure handshake established.</div>
                <div>[09:14:25] Analyzing user patterns.</div>
                <div className="text-accent underline underline-offset-4">[09:14:28] Systems clear. Aero online.</div>
              </div>
            )}
            
            <AnimatePresence>
              {messages.map((m, i) => (
                <motion.div 
                  key={i}
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  className={`text-[11px] leading-relaxed relative border-l-2 pl-3 py-1 transition-colors ${
                    m.role === 'user' ? 'border-accent/10 text-white/70' : 'border-accent text-accent'
                  }`}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <span className="opacity-40 mr-3">[{m.timestamp}]</span>
                      <span className="font-bold mr-2 uppercase tracking-tighter">
                        {m.role === 'user' ? 'USER >' : 'AERO >'}
                      </span>
                    </div>
                  </div>
                  
                  <div className="mt-1">
                    {m.content}
                  </div>

                  {m.type === 'image' && (
                    <div className="mt-4 relative group">
                      {m.status === 'pending' ? (
                        <div className="w-full aspect-video bg-accent/5 border border-dashed border-accent/40 flex flex-col items-center justify-center gap-4 rounded-lg">
                           <motion.div 
                            animate={{ rotate: 360 }}
                            transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                            className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full md:w-16 md:h-16"
                           />
                           <span className="text-[10px] md:text-xs tracking-widest animate-pulse uppercase">Neural Rendering in Progress...</span>
                        </div>
                      ) : m.status === 'completed' && m.mediaUrl ? (
                         <div 
                           className="border-2 border-accent/30 overflow-hidden rounded-lg relative cursor-zoom-in group/img shadow-[0_0_30px_rgba(0,242,255,0.1)]"
                           onClick={() => setSelectedMedia({ url: m.mediaUrl!, type: 'image', content: m.content })}
                         >
                            <img 
                              src={m.mediaUrl} 
                              alt={m.content} 
                              className="w-full object-cover transition-transform duration-700 group-hover/img:scale-105"
                              referrerPolicy="no-referrer"
                            />
                            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent p-4 translate-y-full group-hover/img:translate-y-0 transition-transform duration-300">
                               <div className="flex items-center justify-between">
                                  <span className="text-[10px] uppercase font-bold tracking-widest text-accent">Display Sequence: Visual</span>
                                  <span className="text-[10px] text-white/50">Click to expand</span>
                               </div>
                            </div>
                         </div>
                      ) : m.status === 'error' && (
                        <div className="p-4 border-2 border-red-500/50 bg-red-500/10 text-red-500 text-[10px] md:text-xs uppercase tracking-[0.2em] rounded-lg">
                          SYSTEM_ERR: {m.content}
                        </div>
                      )}
                    </div>
                  )}

                  {m.type === 'archive_action' && (
                    <div className="mt-2 p-2 bg-accent/10 border border-accent/30 rounded flex items-center gap-3">
                      <Database className="w-4 h-4 text-accent animate-pulse" />
                      <span className="text-[10px] uppercase font-bold tracking-widest">{m.content}</span>
                    </div>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
            
            {isProcessing && (
              <div className="text-[11px] animate-pulse opacity-40">
                [{new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) }] AERO {' > '} Processing neural pathways...
              </div>
            )}
          </div>

          <div className="p-5 mt-auto border-t border-accent/10 bg-black/20 text-accent/50">
            <h2 className="text-[10px] uppercase font-bold tracking-[0.2em] mb-4 border-l-2 border-accent pl-3">Project: Vox-Humana</h2>
            <div className="text-[10px] leading-tight opacity-50 mb-3">
              Automating sophisticated vocal interactions and logic execution across neural clusters.
            </div>
            <div className="flex items-center gap-4">
              <div className="flex-1 h-1 bg-accent/10 rounded-full overflow-hidden">
                <div className="h-full bg-accent w-[84%] shadow-[0_0_8px_#00f2ff]" />
              </div>
              <span className="text-[10px] text-accent">84%</span>
            </div>
          </div>
        </aside>

      </main>

      {/* Footer / Command Input */}
      <footer className="h-28 border-t border-accent/20 bg-black/40 px-10 flex items-center justify-between z-50 backdrop-blur-md">
        <div className="flex items-center gap-5">
          <div className={`w-3 h-3 rounded-full border border-accent/40 flex items-center justify-center`}>
             <motion.div 
              animate={{ scale: isListening ? [0.6, 1.2, 0.6] : 0.8 }}
              transition={{ duration: 1, repeat: Infinity }}
              className={`w-1.5 h-1.5 rounded-full ${isListening ? 'bg-red-500 shadow-[0_0_10px_#ef4444]' : 'bg-accent shadow-[0_0_10px_#00f2ff]'}`} 
             />
          </div>
          <span className="text-xs tracking-[0.3em] font-bold opacity-70">
            {isListening ? 'LISTENING...' : 'COMMAND READY'}
          </span>
        </div>

        <div className="flex-1 max-w-2xl px-10">
          <form 
            onSubmit={(e) => { e.preventDefault(); handleSend(); }}
            className="relative"
          >
            <input 
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder='> "Aero, initiate primary diagnostics."'
              className="w-full bg-accent/10 border border-accent/30 rounded-full py-3 px-8 text-sm text-accent placeholder:text-accent/20 focus:outline-none focus:border-accent/60 transition-all shadow-[inset_0_0_15px_rgba(0,242,255,0.05)]"
            />
            <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2">
              <button 
                type="button"
                onClick={toggleListening}
                className={`p-1.5 rounded-full transition-colors ${isListening ? 'text-red-500' : 'text-accent hover:bg-accent/10'}`}
              >
                <Mic className="w-4 h-4" />
              </button>
              <button 
                type="submit"
                disabled={!input.trim() || isProcessing}
                className="p-1.5 text-accent hover:bg-accent/10 rounded-full disabled:opacity-20"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </form>
        </div>

        <div className="text-right hidden sm:block">
          <div className="text-[9px] opacity-40 tracking-widest uppercase mb-1">Voice Profile</div>
          <div className="text-xs font-bold text-white tracking-widest uppercase">MALE // SOPHISTICATED</div>
        </div>
      </footer>

      {/* Media Overlay */}
      <AnimatePresence>
        {selectedMedia && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[2000] bg-black/95 flex flex-col items-center justify-center p-4 md:p-10"
            onClick={() => setSelectedMedia(null)}
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="relative w-full max-w-6xl aspect-video md:aspect-auto flex flex-col items-center gap-6"
              onClick={e => e.stopPropagation()}
            >
              <div className="w-full flex items-center justify-between border-b border-accent/20 pb-4">
                 <div className="flex items-center gap-4">
                    <div className="w-2 h-2 bg-accent rounded-full animate-pulse shadow-[0_0_10px_#00f2ff]" />
                    <span className="text-xs md:text-sm font-bold tracking-[0.4em] text-accent uppercase">
                      Display Matrix: {selectedMedia.type} // {selectedMedia.content.slice(0, 30)}...
                    </span>
                 </div>
                 <button 
                  onClick={() => setSelectedMedia(null)}
                  className="px-6 py-2 border border-accent/30 hover:bg-accent hover:text-black transition-all text-xs tracking-widest uppercase font-bold"
                 >
                   Terminate Display
                 </button>
              </div>

              <div className="flex-1 w-full flex items-center justify-center overflow-hidden rounded-lg border border-accent/10 shadow-[0_0_100px_rgba(0,242,255,0.1)]">
                  <img 
                    src={selectedMedia.url} 
                    alt={selectedMedia.content} 
                    className="max-w-full max-h-[80vh] object-contain"
                  />
              </div>

              <div className="w-full flex justify-center gap-4">
                 <a 
                  href={selectedMedia.url} 
                  download={`aero-${selectedMedia.type}-${Date.now()}`}
                  className="px-8 py-3 bg-accent/10 border border-accent/30 text-accent font-bold tracking-[0.2em] text-[10px] uppercase hover:bg-accent hover:text-black transition-all"
                 >
                   Download Binary
                 </a>
                 <button 
                  onClick={() => setSelectedMedia(null)}
                  className="px-8 py-3 border border-accent/10 text-white/40 font-bold tracking-[0.2em] text-[10px] uppercase hover:text-white transition-all"
                 >
                   Return to Interface
                 </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
