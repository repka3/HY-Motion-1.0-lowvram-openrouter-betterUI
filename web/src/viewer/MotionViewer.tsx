import { Grid, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

import type { MotionActorFrame, MotionFrames } from "../types";
import { disposeWoodenModel, loadWoodenModel, type WoodenModel } from "./woodenModel";

interface MotionViewerProps {
  frames: MotionFrames | null;
  currentFrame: number;
  isPlaying: boolean;
  speed: number;
  resetToken: number;
  onFrameChange: (frame: number) => void;
  onReadyChange?: (ready: boolean) => void;
}

function computeOffsets(actorCount: number): number[] {
  const spacing = 2;
  const startX = -((actorCount - 1) * spacing) / 2;
  return Array.from({ length: actorCount }, (_, index) => startX + index * spacing);
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
  actor,
  offset,
  clipVersion,
  onReady
}: {
  actor: MotionActorFrame;
  offset: number;
  clipVersion: number;
  onReady: (actorId: number) => void;
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
      onReady(actor.id);
    }
  }, [actor.id, clipVersion, model, onReady]);

  useEffect(() => {
    if (!model) return;
    const mesh = model.mesh;
    mesh.position.set((actor.Th[0]?.[0] ?? 0) - offset, actor.Th[0]?.[1] ?? 0, actor.Th[0]?.[2] ?? 0);
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
  }, [actor, model, offset]);

  useEffect(() => {
    return () => {
      if (model) disposeWoodenModel(model);
    };
  }, [model]);

  if (!model) return null;
  return <primitive object={model.mesh} />;
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

function CameraRig({ resetToken }: { resetToken: number }) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const { camera } = useThree();

  useEffect(() => {
    camera.position.set(3.2, 2.4, 4.2);
    camera.lookAt(0, 1, 0);
    if (controlsRef.current) {
      controlsRef.current.target.set(0, 1, 0);
      controlsRef.current.update();
    }
  }, [camera, resetToken]);

  return (
    <OrbitControls
      ref={controlsRef}
      enableDamping
      dampingFactor={0.05}
      minDistance={1}
      maxDistance={15}
      makeDefault
    />
  );
}

function SceneContent({
  frames,
  currentFrame,
  isPlaying,
  speed,
  resetToken,
  onFrameChange,
  onReadyChange
}: MotionViewerProps) {
  const frame = frames?.[currentFrame] ?? null;
  const expectedActorCount = frames?.[0]?.length ?? 0;
  const offsets = useMemo(() => computeOffsets(expectedActorCount), [expectedActorCount]);
  const readyActorIds = useRef<Set<number>>(new Set());
  const [clipVersion, setClipVersion] = useState(0);

  useEffect(() => {
    readyActorIds.current = new Set();
    onReadyChange?.(expectedActorCount === 0);
    setClipVersion((version) => version + 1);
  }, [expectedActorCount, frames, onReadyChange]);

  const handleActorReady = useCallback((actorId: number) => {
    readyActorIds.current.add(actorId);
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
        args={[18, 18]}
        cellSize={0.5}
        sectionSize={2}
        fadeDistance={18}
        fadeStrength={1}
        cellColor="#65635f"
        sectionColor="#98948c"
        position={[0, 0, 0]}
      />
      {frame?.map((actor, index) => (
        <WoodenActor
          key={actor.id}
          actor={actor}
          offset={offsets[index] ?? 0}
          clipVersion={clipVersion}
          onReady={handleActorReady}
        />
      ))}
      <PlaybackTicker
        totalFrames={frames?.length ?? 0}
        currentFrame={currentFrame}
        isPlaying={isPlaying}
        speed={speed}
        onFrameChange={onFrameChange}
      />
      <CameraRig resetToken={resetToken} />
    </>
  );
}

export default function MotionViewer(props: MotionViewerProps) {
  return (
    <Canvas
      shadows
      camera={{ fov: 45, near: 0.1, far: 50, position: [3.2, 2.4, 4.2] }}
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
