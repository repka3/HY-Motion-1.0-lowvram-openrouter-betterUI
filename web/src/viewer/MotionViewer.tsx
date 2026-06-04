import { Grid, Html, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Star } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

import type { ComparisonClip, MotionActorFrame } from "../types";
import { disposeWoodenModel, loadWoodenModel, type WoodenModel } from "./woodenModel";

interface MotionViewerProps {
  clips: ComparisonClip[];
  selectedClipId: string | null;
  currentFrame: number;
  isPlaying: boolean;
  speed: number;
  resetToken: number;
  onFrameChange: (frame: number) => void;
  onReadyChange?: (ready: boolean) => void;
  onClipClick?: (clipId: string) => void;
  onFavoriteClick?: (clipId: string) => void;
}

function computeOffsets(count: number, spacing: number): number[] {
  const startX = -((count - 1) * spacing) / 2;
  return Array.from({ length: count }, (_, index) => startX + index * spacing);
}

function computeClipOffsets(clipCount: number): number[] {
  const spacing = clipCount > 8 ? 1.35 : clipCount > 4 ? 1.7 : 2.2;
  return computeOffsets(clipCount, spacing);
}

function timelineFrameForClip(clip: ComparisonClip, currentFrame: number, totalFrames: number): number {
  if (clip.frames.length < 2 || totalFrames < 2) return 0;
  const normalized = currentFrame / (totalFrames - 1);
  return Math.min(clip.frames.length - 1, Math.round(normalized * (clip.frames.length - 1)));
}

function applyAxisAngle(bone: THREE.Bone, values: number[]): void {
  const axis = new THREE.Vector3(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0);
  const angle = axis.length();
  if (angle > 1e-6) {
    axis.normalize();
    bone.quaternion.setFromAxisAngle(axis, angle);
  } else {
    bone.quaternion.identity();
  }
}

function WoodenActor({
  actorKey,
  actor,
  xOffset,
  clipVersion,
  selected,
  onReady,
  onClick
}: {
  actorKey: string;
  actor: MotionActorFrame;
  xOffset: number;
  clipVersion: number;
  selected: boolean;
  onReady: (actorKey: string) => void;
  onClick: () => void;
}) {
  const [model, setModel] = useState<WoodenModel | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadWoodenModel()
      .then((loaded) => {
        if (cancelled) {
          disposeWoodenModel(loaded);
          return;
        }
        setModel(loaded);
      })
      .catch((error) => {
        console.error(error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (model) {
      onReady(actorKey);
    }
  }, [actorKey, clipVersion, model, onReady]);

  useEffect(() => {
    if (!model) return;
    const mesh = model.mesh;
    mesh.position.set((actor.Th[0]?.[0] ?? 0) + xOffset, actor.Th[0]?.[1] ?? 0, actor.Th[0]?.[2] ?? 0);
    mesh.scale.setScalar(selected ? 1.035 : 1);
    applyAxisAngle(model.bones[0], actor.Rh[0] ?? [0, 0, 0]);

    const poseValues = actor.poses[0] ?? [];
    const poseOffset = poseValues.length === 69 ? -3 : 0;
    for (let index = 1; index < model.bones.length; index += 1) {
      const start = poseOffset + 3 * index;
      if (start >= 0 && start + 2 < poseValues.length) {
        applyAxisAngle(model.bones[index], [poseValues[start], poseValues[start + 1], poseValues[start + 2]]);
      } else {
        model.bones[index].quaternion.identity();
      }
    }
  }, [actor, model, selected, xOffset]);

  useEffect(() => {
    return () => {
      if (model) disposeWoodenModel(model);
    };
  }, [model]);

  if (!model) return null;
  return (
    <primitive
      object={model.mesh}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        onClick();
      }}
      onPointerOver={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        document.body.style.cursor = "";
      }}
    />
  );
}

function PlaybackTicker({
  totalFrames,
  currentFrame,
  isPlaying,
  speed,
  onFrameChange
}: {
  totalFrames: number;
  currentFrame: number;
  isPlaying: boolean;
  speed: number;
  onFrameChange: (frame: number) => void;
}) {
  const accumulator = useRef(0);
  const currentFrameRef = useRef(currentFrame);

  useEffect(() => {
    currentFrameRef.current = currentFrame;
  }, [currentFrame]);

  useFrame((_, delta) => {
    if (!isPlaying || totalFrames < 2) return;
    accumulator.current += delta * speed;
    const frameDuration = 1 / 30;
    if (accumulator.current >= frameDuration) {
      const steps = Math.floor(accumulator.current / frameDuration);
      accumulator.current -= steps * frameDuration;
      onFrameChange((currentFrameRef.current + steps) % totalFrames);
    }
  });

  return null;
}

function CameraRig({ resetToken, clipCount }: { resetToken: number; clipCount: number }) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const { camera } = useThree();

  useEffect(() => {
    const distance = Math.min(28, Math.max(5.2, clipCount * 1.6));
    camera.position.set(0, 2.4, distance);
    camera.lookAt(0, 1, 0);
    if (controlsRef.current) {
      controlsRef.current.target.set(0, 1, 0);
      controlsRef.current.update();
    }
  }, [camera, clipCount, resetToken]);

  return (
    <OrbitControls
      ref={controlsRef}
      enableDamping
      dampingFactor={0.05}
      minDistance={1}
      maxDistance={40}
      makeDefault
    />
  );
}

function SceneContent({
  clips,
  selectedClipId,
  currentFrame,
  isPlaying,
  speed,
  resetToken,
  onFrameChange,
  onReadyChange,
  onClipClick,
  onFavoriteClick
}: MotionViewerProps) {
  const totalFrames = useMemo(() => Math.max(0, ...clips.map((clip) => clip.frames.length)), [clips]);
  const expectedActorCount = useMemo(
    () => clips.reduce((total, clip) => total + (clip.frames[0]?.length ?? 0), 0),
    [clips]
  );
  const clipOffsets = useMemo(() => computeClipOffsets(clips.length), [clips.length]);
  const readyActorIds = useRef<Set<string>>(new Set());
  const [clipVersion, setClipVersion] = useState(0);

  useEffect(() => {
    readyActorIds.current = new Set();
    onReadyChange?.(expectedActorCount === 0);
    setClipVersion((version) => version + 1);
  }, [clips, expectedActorCount, onReadyChange]);

  const handleActorReady = useCallback((actorKey: string) => {
    readyActorIds.current.add(actorKey);
    if (expectedActorCount > 0 && readyActorIds.current.size >= expectedActorCount) {
      onReadyChange?.(true);
    }
  }, [expectedActorCount, onReadyChange]);

  return (
    <>
      <color attach="background" args={["#383735"]} />
      <fog attach="fog" args={["#383735", 9, 28]} />
      <hemisphereLight args={["#ffffff", "#3d352f", 1.18]} position={[0, 2, 0]} />
      <directionalLight
        position={[3.4, 5.2, 4.2]}
        intensity={1.45}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
      />
      <directionalLight position={[-4, 2.8, -2]} intensity={0.45} color="#d9edff" />
      <directionalLight position={[0, 4, -5]} intensity={0.35} color="#fff0da" />
      <Grid
        args={[Math.max(18, clips.length * 3), Math.max(18, clips.length * 3)]}
        cellSize={0.5}
        sectionSize={2}
        fadeDistance={18}
        fadeStrength={1}
        cellColor="#65635f"
        sectionColor="#98948c"
        position={[0, 0, 0]}
      />
      {clips.map((clip, clipIndex) => {
        const clipOffset = clipOffsets[clipIndex] ?? 0;
        const frameIndex = timelineFrameForClip(clip, currentFrame, totalFrames);
        const frame = clip.frames[frameIndex] ?? [];
        const actorOffsets = computeOffsets(frame.length, 0.72);
        const selected = selectedClipId === clip.id;
        const favorited = Boolean(clip.favoriteId);

        return (
          <group key={clip.id}>
            {selected && (
              <mesh position={[clipOffset, 0.018, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                <ringGeometry args={[0.62, 0.78, 64]} />
                <meshBasicMaterial color="#6cbf84" transparent opacity={0.88} side={THREE.DoubleSide} />
              </mesh>
            )}
            <Html position={[clipOffset, 2.18, 0]} center distanceFactor={9}>
              <div className={`viewer-label ${selected ? "selected" : ""}`}>
                <button className="viewer-label-main" onClick={() => onClipClick?.(clip.id)}>
                  <span>V{clip.variationIndex + 1}</span>
                  <b>{clip.seed}</b>
                </button>
                <button
                  className={`viewer-star ${favorited ? "active" : ""}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onFavoriteClick?.(clip.id);
                  }}
                  aria-label={favorited ? "Remove favorite" : "Favorite generation"}
                >
                  <Star size={14} fill={favorited ? "currentColor" : "none"} />
                </button>
              </div>
            </Html>
            {frame.map((actor, actorIndex) => {
              const actorKey = `${clip.id}:${actor.id}:${actorIndex}`;
              return (
                <WoodenActor
                  key={actorKey}
                  actorKey={actorKey}
                  actor={actor}
                  xOffset={clipOffset + (actorOffsets[actorIndex] ?? 0)}
                  clipVersion={clipVersion}
                  selected={selected}
                  onReady={handleActorReady}
                  onClick={() => onClipClick?.(clip.id)}
                />
              );
            })}
          </group>
        );
      })}
      <PlaybackTicker
        totalFrames={totalFrames}
        currentFrame={currentFrame}
        isPlaying={isPlaying}
        speed={speed}
        onFrameChange={onFrameChange}
      />
      <CameraRig resetToken={resetToken} clipCount={clips.length} />
    </>
  );
}

export default function MotionViewer(props: MotionViewerProps) {
  return (
    <Canvas
      shadows
      camera={{ fov: 50, near: 0.1, far: 80, position: [0, 2.4, 5.2] }}
      gl={{ antialias: true, logarithmicDepthBuffer: true }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1;
        gl.outputColorSpace = THREE.SRGBColorSpace;
      }}
    >
      <SceneContent {...props} />
    </Canvas>
  );
}
