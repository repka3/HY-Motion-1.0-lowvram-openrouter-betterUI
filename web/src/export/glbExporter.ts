import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

import type { ComparisonClip, MotionActorFrame } from "../types";
import { disposeWoodenModel, loadWoodenModel, type WoodenModel } from "../viewer/woodenModel";
import { actorForFrame, rootTranslation } from "./motionFix";

const FPS_DEFAULT = 30;
const IDENTITY_QUATERNION = new THREE.Quaternion();

interface GlbExportOptions {
  includeSkin: boolean;
  yOffset: number;
  fps?: number;
}

export async function exportClipToGlb(clip: ComparisonClip, options: GlbExportOptions): Promise<Blob> {
  const fps = options.fps ?? FPS_DEFAULT;
  const model = await loadWoodenModel();
  try {
    const root = new THREE.Group();
    root.name = "HYMotionExport";
    const animationClip = buildAnimationClip(clip, model, {
      includeSkin: options.includeSkin,
      yOffset: options.yOffset,
      fps
    });

    if (options.includeSkin) {
      model.mesh.name = "HYMotionSkin";
      applyActorPose(model, actorForFrame(clip.frames[0]), options.yOffset, true);
      root.add(model.mesh);
    } else {
      model.bones[0].name = model.bones[0].name || "Pelvis";
      applyActorPose(model, actorForFrame(clip.frames[0]), options.yOffset, false);
      root.add(model.bones[0]);
    }

    const buffer = await parseGlb(root, [animationClip]);
    return new Blob([buffer], { type: "model/gltf-binary" });
  } finally {
    disposeWoodenModel(model);
  }
}

function buildAnimationClip(
  clip: ComparisonClip,
  model: WoodenModel,
  {
    includeSkin,
    yOffset,
    fps
  }: {
    includeSkin: boolean;
    yOffset: number;
    fps: number;
  }
): THREE.AnimationClip {
  const times = clip.frames.map((_, index) => index / fps);
  const tracks: THREE.KeyframeTrack[] = [];
  const translationValues: number[] = [];
  const boneQuaternionValues = model.bones.map(() => [] as number[]);

  for (const frame of clip.frames) {
    const actor = actorForFrame(frame);
    const [x, y, z] = rootTranslation(actor);
    translationValues.push(x, y + yOffset, z);

    model.bones.forEach((_, boneIndex) => {
      const quaternion = quaternionForBone(actor, boneIndex);
      boneQuaternionValues[boneIndex].push(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    });
  }

  const rootPositionTrack = includeSkin ? "HYMotionSkin.position" : `${model.bones[0].name}.position`;
  tracks.push(new THREE.VectorKeyframeTrack(rootPositionTrack, times, translationValues));

  model.bones.forEach((bone, boneIndex) => {
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, boneQuaternionValues[boneIndex]));
  });

  return new THREE.AnimationClip("HYMotion_Animation", -1, tracks);
}

function applyActorPose(model: WoodenModel, actor: MotionActorFrame | null, yOffset: number, skinRootOnMesh: boolean): void {
  const [x, y, z] = rootTranslation(actor);
  const rootObject = skinRootOnMesh ? model.mesh : model.bones[0];
  rootObject.position.set(x, y + yOffset, z);
  model.bones.forEach((bone, index) => {
    bone.quaternion.copy(quaternionForBone(actor, index));
  });
}

function quaternionForBone(actor: MotionActorFrame | null, boneIndex: number): THREE.Quaternion {
  if (!actor) return IDENTITY_QUATERNION.clone();
  if (boneIndex === 0) {
    return axisAngleToQuaternion(actor.Rh[0] ?? [0, 0, 0]);
  }

  const poseValues = actor.poses[0] ?? [];
  const poseOffset = poseValues.length === 69 ? -3 : 0;
  const start = poseOffset + 3 * boneIndex;
  if (start >= 0 && start + 2 < poseValues.length) {
    return axisAngleToQuaternion([poseValues[start], poseValues[start + 1], poseValues[start + 2]]);
  }
  return IDENTITY_QUATERNION.clone();
}

function axisAngleToQuaternion(values: number[]): THREE.Quaternion {
  const axis = new THREE.Vector3(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0);
  const angle = axis.length();
  if (angle <= 1e-6) return IDENTITY_QUATERNION.clone();
  axis.normalize();
  return new THREE.Quaternion().setFromAxisAngle(axis, angle);
}

function parseGlb(root: THREE.Object3D, animations: THREE.AnimationClip[]): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(
      root,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result);
          return;
        }
        const text = JSON.stringify(result);
        resolve(new TextEncoder().encode(text).buffer);
      },
      reject,
      {
        binary: true,
        animations,
        trs: false,
        onlyVisible: true
      }
    );
  });
}
