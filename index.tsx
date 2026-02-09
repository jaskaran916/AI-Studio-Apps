
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Modality, Type } from "@google/genai";

// --- Types & Constants ---
type EntityType = 'HVT' | 'Civilian' | 'Bodyguard' | 'Barrel' | 'Crate' | 'Intel' | 'Glass';

interface Entity {
  id: string;
  x: number;
  y: number;
  z: number;
  speed: number;
  type: EntityType;
  description: string;
  isDead: boolean;
  behavior: 'static' | 'pacing' | 'erratic' | 'flanking';
  offset: number;
  health: number;
  isHostile: boolean;
  lastFireTime: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  size: number;
}

interface Objective {
  id: string;
  type: 'recon' | 'destroy' | 'eliminate' | 'retrieve';
  targetId?: string;
  description: string;
  isComplete: boolean;
}

interface Mission {
  title: string;
  briefing: string;
  objectives: Objective[];
  environment: string;
  windSpeed: number;
  windDir: number;
}

const SCOPE_SIZE = 400;
const AUDIO_SAMPLE_RATE = 24000;
const MAX_PLAYER_HEALTH = 100;

// --- Helper Functions ---
function decode(base64: string) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

// --- App Component ---
const App = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const aiRef = useRef<GoogleGenAI | null>(null);
  const [mission, setMission] = useState<Mission | null>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [particles, setParticles] = useState<Particle[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [gameState, setGameState] = useState<'briefing' | 'playing' | 'success' | 'failure'>('briefing');
  const [playerHealth, setPlayerHealth] = useState(MAX_PLAYER_HEALTH);
  const [shotsFired, setShotsFired] = useState(0);
  const [currentObjIndex, setCurrentObjIndex] = useState(0);

  const mousePos = useRef({ x: 0, y: 0 });
  const swayOffset = useRef({ x: 0, y: 0 });
  const screenShake = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    aiRef.current = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
    generateMission();
    
    const handleMouseMove = (e: MouseEvent) => {
      mousePos.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  const generateMission = async () => {
    setIsLoading(true);
    const ai = aiRef.current;
    if (!ai) return;

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3-pro-preview',
        contents: "Generate a multi-objective tactical sniper mission briefing. Objectives should follow a logical order: 1. Recon (find something), 2. Sabotage (destroy explosive barrels or glass), 3. Retrieval (intel), 4. Elimination (HVT). Return JSON with fields: title, briefing, objectives (list of {type, description}), environment (urban/rain), windSpeed (0-15), windDir (0-360).",
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              briefing: { type: Type.STRING },
              objectives: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    type: { type: Type.STRING },
                    description: { type: Type.STRING }
                  }
                }
              },
              environment: { type: Type.STRING },
              windSpeed: { type: Type.NUMBER },
              windDir: { type: Type.NUMBER },
            }
          }
        }
      });

      const data = JSON.parse(response.text || '{}') as Mission;
      setMission(data);
      spawnEntities(data);
      setIsLoading(false);
      speakSpotter(`Mission: ${data.title}. Objective one: ${data.objectives[0].description}.`);
    } catch (error) {
      console.error("Failed to generate mission", error);
      setIsLoading(false);
    }
  };

  const spawnEntities = (missionData: Mission) => {
    const newEntities: Entity[] = [];
    
    // Spawn HVT
    newEntities.push({
      id: 'hvt-1',
      x: 400 + Math.random() * 800,
      y: window.innerHeight / 2,
      z: 800,
      speed: 2,
      type: 'HVT',
      description: 'The High Value Target',
      isDead: false,
      behavior: 'pacing',
      offset: Math.random() * 10,
      health: 100,
      isHostile: false,
      lastFireTime: 0
    });

    // Spawn Environmentals
    for (let i = 0; i < 5; i++) {
      newEntities.push({
        id: `barrel-${i}`,
        x: Math.random() * window.innerWidth,
        y: window.innerHeight / 2 + 50,
        z: 600 + Math.random() * 400,
        speed: 0,
        type: 'Barrel',
        description: 'Explosive chemical drum',
        isDead: false,
        behavior: 'static',
        offset: 0,
        health: 1,
        isHostile: false,
        lastFireTime: 0
      });
    }

    // Spawn Hostile Guard
    newEntities.push({
      id: 'guard-1',
      x: 200,
      y: window.innerHeight / 2,
      z: 700,
      speed: 1.5,
      type: 'Bodyguard',
      description: 'Elite security personnel',
      isDead: false,
      behavior: 'flanking',
      offset: 0,
      health: 100,
      isHostile: true,
      lastFireTime: 0
    });

    // Spawn Intel
    newEntities.push({
      id: 'intel-1',
      x: window.innerWidth / 2 + 100,
      y: window.innerHeight / 2 + 20,
      z: 650,
      speed: 0,
      type: 'Intel',
      description: 'Encrypted data drive',
      isDead: false,
      behavior: 'static',
      offset: 0,
      health: 10,
      isHostile: false,
      lastFireTime: 0
    });

    setEntities(newEntities);
  };

  const createParticles = (x: number, y: number, color: string, count: number, size: number = 2) => {
    const newParticles: Particle[] = [];
    for (let i = 0; i < count; i++) {
      newParticles.push({
        x, y,
        vx: (Math.random() - 0.5) * 10,
        vy: (Math.random() - 0.5) * 10,
        life: 1.0,
        color,
        size
      });
    }
    setParticles(prev => [...prev, ...newParticles].slice(-100));
  };

  const speakSpotter = async (text: string) => {
    const ai = aiRef.current;
    if (!ai) return;
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: AUDIO_SAMPLE_RATE });
      }
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: `Speak in a gritty, professional C++ engine voice/tactical spotter: "${text}"` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const ctx = audioContextRef.current;
        const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, AUDIO_SAMPLE_RATE, 1);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        source.start();
      }
    } catch (e) {
      console.error("Spotter speech failed", e);
    }
  };

  useEffect(() => {
    if (gameState !== 'playing' || !mission) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;
    const startTime = Date.now();

    const render = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const time = (Date.now() - startTime) / 1000;

      // Update Screen Shake
      screenShake.current *= 0.9;

      // Sway calculation
      const heartbeat = 0.5 + Math.sin(time * 2.5) * 0.2;
      swayOffset.current.x = Math.sin(time * 0.7) * 12 * heartbeat + (Math.random() - 0.5) * screenShake.current;
      swayOffset.current.y = Math.cos(time * 1.1) * 8 * heartbeat + (Math.random() - 0.5) * screenShake.current;

      ctx.fillStyle = '#050505';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Distant Parallax
      ctx.strokeStyle = '#002208';
      for (let i = 0; i < 15; i++) {
        const bx = ((i * 200 - mousePos.current.x * 0.05) % (canvas.width + 200)) - 200;
        ctx.strokeRect(bx, canvas.height - 400, 150, 400);
      }

      // Update & Draw Entities
      entities.forEach(ent => {
        if (ent.isDead && ent.type !== 'Barrel') return;

        // AI Behaviors
        if (!ent.isDead) {
          if (ent.behavior === 'pacing') {
            ent.x += Math.sin(time + ent.offset) * ent.speed;
          } else if (ent.behavior === 'flanking') {
            ent.z -= 0.5; // Moving closer
            ent.x += Math.cos(time * 0.5) * 2;
            if (ent.z < 400) ent.z = 1000; // Reset or hide
          }

          // Return Fire Logic
          if (ent.isHostile && Date.now() - ent.lastFireTime > 2000) {
            ent.lastFireTime = Date.now();
            screenShake.current = 15;
            setPlayerHealth(prev => Math.max(0, prev - 10));
            createParticles(canvas.width / 2, canvas.height / 2, '#ff0000', 5, 4);
            // Flash on source
            const rx = ent.x - (mousePos.current.x - canvas.width / 2) * (1 - 400 / ent.z);
            const ry = ent.y - (mousePos.current.y - canvas.height / 2) * (1 - 400 / ent.z);
            createParticles(rx, ry, '#ffff00', 10, 2);
          }
        }

        const scale = 600 / ent.z;
        const rx = ent.x - (mousePos.current.x - canvas.width / 2) * (1 - 400 / ent.z);
        const ry = ent.y - (mousePos.current.y - canvas.height / 2) * (1 - 400 / ent.z);

        ctx.save();
        ctx.translate(rx, ry);
        ctx.scale(scale, scale);

        if (ent.type === 'Barrel') {
          ctx.fillStyle = ent.isDead ? '#330000' : '#ff3300';
          ctx.fillRect(-15, -20, 30, 40);
          ctx.strokeStyle = '#fff';
          ctx.strokeRect(-15, -20, 30, 40);
        } else if (ent.type === 'Intel') {
          ctx.fillStyle = '#00ffff';
          ctx.beginPath();
          ctx.moveTo(-10, -10); ctx.lineTo(10, -10); ctx.lineTo(15, 0); ctx.lineTo(10, 10); ctx.lineTo(-10, 10); ctx.closePath();
          ctx.fill();
        } else if (ent.type === 'HVT' || ent.type === 'Bodyguard' || ent.type === 'Civilian') {
          if (!ent.isDead) {
            ctx.fillStyle = ent.type === 'HVT' ? '#00ff41' : ent.type === 'Bodyguard' ? '#ff0000' : '#004410';
            ctx.beginPath(); ctx.arc(0, -50, 15, 0, Math.PI * 2); ctx.fill(); // Head
            ctx.fillRect(-15, -35, 30, 70); // Body
            if (ent.isHostile) {
               ctx.strokeStyle = '#ff0000';
               ctx.lineWidth = 1;
               ctx.strokeRect(-20, -60, 40, 100);
            }
          }
        }
        ctx.restore();
      });

      // Particles
      setParticles(prev => prev.filter(p => p.life > 0).map(p => ({
        ...p,
        x: p.x + p.vx,
        y: p.y + p.vy,
        life: p.life - 0.02
      })));

      particles.forEach(p => {
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.life;
        ctx.fillRect(p.x, p.y, p.size, p.size);
      });
      ctx.globalAlpha = 1.0;

      // Scope Overlay
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const finalX = centerX + swayOffset.current.x;
      const finalY = centerY + swayOffset.current.y;

      ctx.save();
      ctx.beginPath();
      ctx.arc(centerX, centerY, SCOPE_SIZE / 2, 0, Math.PI * 2);
      ctx.rect(canvas.width, 0, -canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      ctx.fill('evenodd');

      ctx.strokeStyle = '#00ff41';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(centerX, centerY, SCOPE_SIZE / 2, 0, Math.PI * 2);
      ctx.stroke();

      // Crosshair
      ctx.beginPath();
      ctx.moveTo(finalX - 100, finalY); ctx.lineTo(finalX + 100, finalY);
      ctx.moveTo(finalX, finalY - 100); ctx.lineTo(finalX, finalY + 100);
      ctx.stroke();

      // HUD
      ctx.fillStyle = '#00ff41';
      ctx.font = '10px "JetBrains Mono"';
      ctx.fillText(`WIND_X: ${mission.windSpeed}KT`, finalX + 40, finalY - 40);
      ctx.fillText(`OBJ_TRACK: ${mission.objectives[currentObjIndex].description}`, finalX + 40, finalY - 25);
      
      ctx.restore();

      // Tactical HUD
      ctx.font = '14px "JetBrains Mono"';
      ctx.fillStyle = '#00ff41';
      ctx.fillText(`HEALTH: [${'#'.repeat(Math.ceil(playerHealth / 10))}${'.'.repeat(10 - Math.ceil(playerHealth / 10))}] ${playerHealth}%`, 40, 50);
      ctx.fillText(`OBJ_${currentObjIndex + 1}: ${mission.objectives[currentObjIndex].description.toUpperCase()}`, 40, 75);
      
      if (playerHealth <= 0) {
        setGameState('failure');
        speakSpotter("Agent neutralized. Mission failed.");
      }

      animationId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationId);
  }, [gameState, mission, entities, particles, currentObjIndex, playerHealth]);

  const handleShoot = useCallback(() => {
    if (gameState !== 'playing') return;
    
    setShotsFired(prev => prev + 1);
    screenShake.current = 10;

    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const impactX = centerX + swayOffset.current.x;
    const impactY = centerY + swayOffset.current.y;

    let hitOccurred = false;
    const currentObj = mission?.objectives[currentObjIndex];

    const nextEntities = entities.map(ent => {
      if (ent.isDead && ent.type !== 'Barrel') return ent;

      const scale = 600 / ent.z;
      const rx = ent.x - (mousePos.current.x - window.innerWidth / 2) * (1 - 400 / ent.z);
      const ry = ent.y - (mousePos.current.y - window.innerHeight / 2) * (1 - 400 / ent.z);
      
      const dx = impactX - rx;
      const dy = impactY - ry;
      
      const isHit = Math.abs(dx) < 25 * scale && Math.abs(dy) < 50 * scale;

      if (isHit && !ent.isDead) {
        hitOccurred = true;
        createParticles(impactX, impactY, ent.type === 'Barrel' ? '#ffaa00' : '#ff0000', 15);

        if (ent.type === 'Barrel') {
          // EXPLOSION PHYSICS
          screenShake.current = 40;
          createParticles(impactX, impactY, '#ff5500', 40, 5);
          // Chain reaction check
          setTimeout(() => {
            setEntities(currentEntities => currentEntities.map(other => {
              const d = Math.hypot(ent.x - other.x, ent.y - other.y);
              if (d < 300 && other.id !== ent.id) return { ...other, isDead: true };
              return other;
            }));
          }, 50);

          if (currentObj?.type === 'destroy') advanceObjective();
        }

        if (ent.type === 'Intel' && currentObj?.type === 'retrieve') advanceObjective();
        if (ent.type === 'HVT' && currentObj?.type === 'eliminate') advanceObjective();

        return { ...ent, isDead: true, health: 0 };
      }
      return ent;
    });

    if (!hitOccurred) {
      // Ricochet effect on miss
      createParticles(impactX, impactY, '#ffffff', 3, 1);
    }

    setEntities(nextEntities);
  }, [gameState, entities, mission, currentObjIndex]);

  const advanceObjective = () => {
    if (!mission) return;
    const nextIndex = currentObjIndex + 1;
    if (nextIndex >= mission.objectives.length) {
      setGameState('success');
      speakSpotter("All objectives clear. Area sanitized. Good work.");
    } else {
      setCurrentObjIndex(nextIndex);
      speakSpotter(`Objective complete. Next task: ${mission.objectives[nextIndex].description}`);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-black text-[#00ff41]">
        <div className="text-4xl mb-4 font-bold tracking-widest glitch font-mono">NEURAL_LINK_ESTABLISHING...</div>
        <div className="w-64 h-2 bg-gray-900 overflow-hidden relative border border-[#00ff41]/30">
          <div className="absolute top-0 left-0 h-full bg-[#00ff41] animate-[loading_2s_infinite] shadow-[0_0_10px_#00ff41]"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-screen overflow-hidden bg-black font-mono">
      {gameState === 'briefing' && mission && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-black/95 p-8 backdrop-blur-sm">
          <div className="max-w-3xl border border-[#00ff41] p-12 bg-black/80 shadow-[0_0_50px_rgba(0,255,65,0.1)]">
            <h1 className="text-5xl font-bold mb-6 text-[#00ff41] border-b border-[#00ff41]/30 pb-4 tracking-tighter">OPERATIONAL_ORDER: {mission.title}</h1>
            <p className="text-xl mb-8 leading-relaxed text-[#00ff41]/80">{mission.briefing}</p>
            
            <div className="grid grid-cols-1 gap-4 mb-10">
              {mission.objectives.map((obj, i) => (
                <div key={i} className="flex items-center gap-4 bg-[#001104] p-4 border border-[#00ff41]/20">
                  <div className="w-8 h-8 rounded-full border border-[#00ff41] flex items-center justify-center text-sm font-bold">
                    {i + 1}
                  </div>
                  <div>
                    <span className="text-xs text-[#00ff41]/50 uppercase">{obj.type}</span>
                    <p className="text-[#00ff41]">{obj.description}</p>
                  </div>
                </div>
              ))}
            </div>

            <button 
              onClick={() => setGameState('playing')}
              className="w-full py-6 bg-[#00ff41] text-black font-bold text-2xl hover:bg-white hover:scale-[1.02] transition-all duration-300 uppercase tracking-widest shadow-[0_0_20px_#00ff41]"
            >
              INITIALIZE_SEQUENCE
            </button>
          </div>
        </div>
      )}

      {(gameState === 'success' || gameState === 'failure') && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-black/90 p-8">
          <div className={`max-w-xl border p-12 bg-black shadow-2xl ${gameState === 'success' ? 'border-[#00ff41] shadow-[#00ff41]/20' : 'border-red-600 shadow-red-600/20'}`}>
            <h1 className={`text-6xl font-black mb-6 tracking-tighter ${gameState === 'success' ? 'text-[#00ff41]' : 'text-red-500'}`}>
              MISSION_{gameState.toUpperCase()}
            </h1>
            <p className="text-xl mb-10 opacity-80">
              {gameState === 'success' 
                ? 'Primary and secondary objectives neutralized. Operational integrity: 100%.' 
                : 'Asset loss detected. Mission scrubbed. Extracting remaining data components.'}
            </p>
            <button 
              onClick={() => window.location.reload()}
              className={`w-full py-5 font-bold text-xl transition-all ${gameState === 'success' ? 'bg-[#00ff41] text-black hover:bg-white' : 'bg-red-600 text-black hover:bg-red-400'}`}
            >
              RESTART_ENGINE
            </button>
          </div>
        </div>
      )}

      <canvas 
        ref={canvasRef} 
        onMouseDown={handleShoot}
        className="w-full h-full"
      />
      
      {/* Telemetry */}
      <div className="absolute top-6 right-6 text-right pointer-events-none opacity-60">
        <div className="text-[#00ff41] text-sm font-bold">ENGINE_RUNTIME: 0x{Math.floor(Date.now()/1000).toString(16)}</div>
        <div className="text-[#00ff41] text-xs">THREAD_POOL: ACTIVE (16)</div>
        <div className="text-[#00ff41] text-xs">AI_SUBSYSTEM: NEURAL_CHAIN_V3</div>
      </div>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
