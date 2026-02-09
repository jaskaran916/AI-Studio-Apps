
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
  description: string;
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

const App = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mission, setMission] = useState<Mission | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [gameState, setGameState] = useState<'briefing' | 'playing' | 'success' | 'failure'>('briefing');
  const [currentObjIndex, setCurrentObjIndex] = useState(0);
  const [healthUI, setHealthUI] = useState(MAX_PLAYER_HEALTH);

  // High-frequency refs for the game loop
  const entitiesRef = useRef<Entity[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const playerHealthRef = useRef(MAX_PLAYER_HEALTH);
  const mousePos = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const swayOffset = useRef({ x: 0, y: 0 });
  const screenShake = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);

  const generateMission = useCallback(async () => {
    setIsLoading(true);
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        // Update prompt to include 'id' and match Objective union types
        contents: "Generate a multi-objective tactical sniper mission. Objectives: 1. recon, 2. destroy, 3. retrieve, 4. eliminate. Return JSON: {title, briefing, objectives: [{id, type, description}], environment, windSpeed, windDir}.",
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
                    // Fix: Added missing 'id' to schema to satisfy Objective interface
                    id: { type: Type.STRING },
                    type: { type: Type.STRING },
                    description: { type: Type.STRING }
                  },
                  propertyOrdering: ["id", "type", "description"]
                }
              },
              environment: { type: Type.STRING },
              windSpeed: { type: Type.NUMBER },
              windDir: { type: Type.NUMBER },
            },
            propertyOrdering: ["title", "briefing", "objectives", "environment", "windSpeed", "windDir"]
          }
        }
      });

      const data = JSON.parse(response.text || '{}') as Mission;
      setMission(data);
      spawnEntities();
      setIsLoading(false);
      speakSpotter(`Mission: ${data.title}. Active objective: ${data.objectives[0].description}.`);
    } catch (error: any) {
      console.error("Mission generation failed:", error);
      setIsLoading(false);
      // Fallback local mission if API fails
      // Fix: Added missing 'id' property to fallback objectives to satisfy Objective interface
      const fallback: Mission = {
        title: "SILENT ECHO",
        briefing: "API Connection lost. Proceeding with emergency tactical protocols. Clear the sector.",
        objectives: [
          { id: 'fb-obj-1', type: 'eliminate', description: "Eliminate the rooftop guard." },
          { id: 'fb-obj-2', type: 'destroy', description: "Destroy the fuel barrels." }
        ],
        environment: "urban",
        windSpeed: 5,
        windDir: 90
      };
      setMission(fallback);
      spawnEntities();
    }
  }, []);

  useEffect(() => {
    generateMission();
    
    const handleMouseMove = (e: MouseEvent) => {
      mousePos.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [generateMission]);

  const spawnEntities = () => {
    const newEntities: Entity[] = [
      { id: 'hvt-1', x: 800, y: window.innerHeight / 2, z: 800, speed: 2, type: 'HVT', description: 'Primary Target', isDead: false, behavior: 'pacing', offset: 0, health: 100, isHostile: false, lastFireTime: 0 },
      { id: 'guard-1', x: 200, y: window.innerHeight / 2, z: 700, speed: 1.5, type: 'Bodyguard', description: 'Security', isDead: false, behavior: 'flanking', offset: 0, health: 100, isHostile: true, lastFireTime: 0 },
      { id: 'intel-1', x: window.innerWidth / 2, y: window.innerHeight / 2 + 20, z: 650, speed: 0, type: 'Intel', description: 'Data', isDead: false, behavior: 'static', offset: 0, health: 10, isHostile: false, lastFireTime: 0 }
    ];
    for (let i = 0; i < 3; i++) {
      newEntities.push({ id: `barrel-${i}`, x: 300 + i * 400, y: window.innerHeight / 2 + 50, z: 600, speed: 0, type: 'Barrel', description: 'Explosive', isDead: false, behavior: 'static', offset: 0, health: 1, isHostile: false, lastFireTime: 0 });
    }
    entitiesRef.current = newEntities;
  };

  const createParticles = (x: number, y: number, color: string, count: number, size: number = 2) => {
    for (let i = 0; i < count; i++) {
      particlesRef.current.push({
        x, y,
        vx: (Math.random() - 0.5) * 10,
        vy: (Math.random() - 0.5) * 10,
        life: 1.0,
        color,
        size
      });
    }
    if (particlesRef.current.length > 200) particlesRef.current.splice(0, particlesRef.current.length - 200);
  };

  const speakSpotter = async (text: string) => {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    try {
      if (!audioContextRef.current) audioContextRef.current = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: `Tactical spotter brief: "${text}"` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } },
        },
      });
      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const ctx = audioContextRef.current;
        const buffer = await decodeAudioData(decode(base64Audio), ctx, AUDIO_SAMPLE_RATE, 1);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start();
      }
    } catch (e) {
      console.warn("TTS Failed", e);
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

      screenShake.current *= 0.9;
      const heartbeat = 0.5 + Math.sin(time * 2.5) * 0.2;
      swayOffset.current.x = Math.sin(time * 0.7) * 12 * heartbeat + (Math.random() - 0.5) * screenShake.current;
      swayOffset.current.y = Math.cos(time * 1.1) * 8 * heartbeat + (Math.random() - 0.5) * screenShake.current;

      ctx.fillStyle = '#050505';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Parallax Background
      ctx.strokeStyle = '#002208';
      for (let i = 0; i < 15; i++) {
        const bx = ((i * 200 - mousePos.current.x * 0.05) % (canvas.width + 200)) - 200;
        ctx.strokeRect(bx, canvas.height - 400, 150, 400);
      }

      // Entities Rendering
      entitiesRef.current.forEach(ent => {
        if (ent.isDead && ent.type !== 'Barrel') return;
        if (!ent.isDead) {
          if (ent.behavior === 'pacing') ent.x += Math.sin(time + ent.offset) * ent.speed;
          if (ent.behavior === 'flanking') { ent.z -= 0.5; ent.x += Math.cos(time * 0.5) * 2; }
          if (ent.isHostile && Date.now() - ent.lastFireTime > 3000) {
            ent.lastFireTime = Date.now();
            screenShake.current = 20;
            playerHealthRef.current -= 10;
            setHealthUI(playerHealthRef.current);
            createParticles(canvas.width / 2, canvas.height / 2, '#ff0000', 5, 4);
          }
        }
        const scale = 600 / ent.z;
        const rx = ent.x - (mousePos.current.x - canvas.width / 2) * (1 - 400 / ent.z);
        const ry = ent.y - (mousePos.current.y - canvas.height / 2) * (1 - 400 / ent.z);
        ctx.save();
        ctx.translate(rx, ry);
        ctx.scale(scale, scale);
        ctx.fillStyle = ent.type === 'Barrel' ? (ent.isDead ? '#200' : '#f30') : ent.type === 'HVT' ? '#0f4' : ent.type === 'Bodyguard' ? '#f00' : '#00ffff';
        if (ent.type === 'Barrel') ctx.fillRect(-15, -20, 30, 40);
        else { ctx.beginPath(); ctx.arc(0, -50, 15, 0, Math.PI * 2); ctx.fill(); ctx.fillRect(-15, -35, 30, 70); }
        ctx.restore();
      });

      // Particle Simulation
      particlesRef.current.forEach((p) => {
        p.x += p.vx; p.y += p.vy; p.life -= 0.02;
        ctx.fillStyle = p.color; ctx.globalAlpha = p.life; ctx.fillRect(p.x, p.y, p.size, p.size);
      });
      particlesRef.current = particlesRef.current.filter(p => p.life > 0);
      ctx.globalAlpha = 1;

      // Scope Overlay
      const centerX = canvas.width / 2, centerY = canvas.height / 2;
      ctx.save();
      ctx.beginPath(); ctx.arc(centerX, centerY, SCOPE_SIZE / 2, 0, Math.PI * 2); ctx.rect(canvas.width, 0, -canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fill('evenodd');
      ctx.strokeStyle = '#0f4'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(centerX, centerY, SCOPE_SIZE / 2, 0, Math.PI * 2); ctx.stroke();
      const fx = centerX + swayOffset.current.x, fy = centerY + swayOffset.current.y;
      ctx.beginPath(); ctx.moveTo(fx - 100, fy); ctx.lineTo(fx + 100, fy); ctx.moveTo(fx, fy - 100); ctx.lineTo(fx, fy + 100); ctx.stroke();
      ctx.restore();

      if (playerHealthRef.current <= 0) setGameState('failure');
      animationId = requestAnimationFrame(render);
    };
    render();
    return () => cancelAnimationFrame(animationId);
  }, [gameState, mission]);

  const handleShoot = useCallback(() => {
    if (gameState !== 'playing') return;
    screenShake.current = 15;
    const impactX = window.innerWidth / 2 + swayOffset.current.x;
    const impactY = window.innerHeight / 2 + swayOffset.current.y;
    let hit = false;

    entitiesRef.current.forEach(ent => {
      if (ent.isDead) return;
      const rx = ent.x - (mousePos.current.x - window.innerWidth / 2) * (1 - 400 / ent.z);
      const ry = ent.y - (mousePos.current.y - window.innerHeight / 2) * (1 - 400 / ent.z);
      const scale = 600 / ent.z;
      if (Math.abs(impactX - rx) < 30 * scale && Math.abs(impactY - ry) < 60 * scale) {
        hit = true;
        ent.isDead = true;
        createParticles(impactX, impactY, '#f00', 15);
        const obj = mission?.objectives[currentObjIndex];
        if ((ent.type === 'Barrel' && obj?.type === 'destroy') || (ent.type === 'Intel' && obj?.type === 'retrieve') || (ent.type === 'HVT' && obj?.type === 'eliminate')) {
          if (currentObjIndex + 1 >= (mission?.objectives.length || 0)) {
            setGameState('success');
            speakSpotter("Mission accomplished.");
          } else {
            setCurrentObjIndex(prev => prev + 1);
            speakSpotter(`Objective cleared. Moving to next: ${mission?.objectives[currentObjIndex + 1].description}`);
          }
        }
      }
    });
    if (!hit) createParticles(impactX, impactY, '#fff', 3, 1);
  }, [gameState, mission, currentObjIndex]);

  if (isLoading) return <div className="flex items-center justify-center h-screen bg-black text-[#0f4] font-mono animate-pulse uppercase tracking-[0.2em]">Initialising_Neural_Strike_v3...</div>;

  return (
    <div className="relative w-full h-screen overflow-hidden bg-black font-mono">
      {gameState === 'briefing' && mission && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-black/95 p-8">
          <div className="max-w-2xl border border-[#0f4] p-10 bg-black shadow-[0_0_30px_rgba(0,255,68,0.1)]">
            <h2 className="text-3xl font-bold mb-4 text-[#0f4] tracking-tighter">OP_ORDER: {mission.title}</h2>
            <p className="mb-8 opacity-80 leading-relaxed text-sm">{mission.briefing}</p>
            <div className="mb-8 border-l-2 border-[#0f4]/30 pl-4 space-y-2">
              <div className="text-xs uppercase opacity-50">Current Objectives:</div>
              {mission.objectives.map((o, idx) => (
                <div key={idx} className={`text-xs ${idx === currentObjIndex ? 'text-[#0f4] font-bold' : 'opacity-40'}`}>
                   [{idx + 1}] {o.description}
                </div>
              ))}
            </div>
            <button onClick={() => setGameState('playing')} className="w-full py-4 bg-[#0f4] text-black font-bold uppercase tracking-[0.3em] hover:bg-white transition-colors duration-300">COMMENCE_OPS</button>
          </div>
        </div>
      )}
      {(gameState === 'success' || gameState === 'failure') && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-black/90 p-8">
          <div className={`max-w-xl border p-12 bg-black shadow-2xl ${gameState === 'success' ? 'border-[#0f4]' : 'border-red-600'}`}>
            <h1 className={`text-6xl font-black mb-6 tracking-tighter ${gameState === 'success' ? 'text-[#0f4]' : 'text-red-500'}`}>MISSION_{gameState.toUpperCase()}</h1>
            <p className="text-sm opacity-60 mb-10">System telemetry suggests operational conclusion. Awaiting further commands from command center.</p>
            <button onClick={() => window.location.reload()} className="w-full py-5 bg-white text-black font-bold text-xl uppercase tracking-widest hover:bg-[#0f4] transition-colors duration-300">REBOOT_SYSTEM</button>
          </div>
        </div>
      )}
      <canvas ref={canvasRef} onMouseDown={handleShoot} className="w-full h-full" />
      <div className="absolute top-6 left-6 text-[#0f4] pointer-events-none select-none">
        <div className="text-2xl font-bold tracking-tighter">HEALTH: {healthUI}%</div>
        <div className="text-xs opacity-60 uppercase mt-1">OBJ: {mission?.objectives[currentObjIndex]?.description}</div>
      </div>
      <div className="absolute bottom-6 right-6 text-[#0f4] text-[10px] opacity-30 select-none pointer-events-none">
        GEMINI_NEURAL_LINK_STABLE // VERSION_3.0_FLASH
      </div>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
