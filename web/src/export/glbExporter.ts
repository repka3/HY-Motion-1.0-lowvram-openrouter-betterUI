import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

import type { ComparisonClip, MotionActorFrame } from "../types";
import { disposeWoodenModel, loadWoodenModel, type WoodenModel } from "../viewer/woodenModel";
import { actorForFrame, rootTranslation } from "./motionFix";

const FPS_DEFAULT = 30;
const IDENTITY_QUATERNION = new THREE.Quaternion();
const EXPORT_ARMATURE_NAME = "HYMotionArmature";

interface GlbExportOptions {
  includeSkin: boolean;
  yOffset: number;
  fps?: number;
}

export async function exportClipToGlb(clip: ComparisonClip, options: GlbExportOptions): Promise<Blob> {
  const fps = options.fps ?? FPS_DEFAULT;
  const model = await loadWoodenModel();
  let carrierMesh: THREE.SkinnedMesh | null = null;
  try {
    const root = new THREE.Group();
    root.name = "HYMotionExport";
    const rootRestPosition = model.bones[0].position.clone();
    const exportMesh = options.includeSkin ? model.mesh : createSkeletonCarrierMesh(model);
    exportMesh.name = EXPORT_ARMATURE_NAME;
    applyRestPose(model, actorForFrame(clip.frames[0]), options.yOffset, rootRestPosition);
    exportMesh.updateMatrixWorld(true);
    exportMesh.skeleton.calculateInverses();

    const animationClip = buildAnimationClip(clip, model, {
      skinnedMeshName: exportMesh.name,
      yOffset: options.yOffset,
      fps,
      rootRestPosition
    });

    if (!options.includeSkin) {
      carrierMesh = exportMesh;
    }
    root.add(exportMesh);

    const buffer = await parseGlb(root, [animationClip]);
    return new Blob([buffer], { type: "model/gltf-binary" });
  } finally {
    if (carrierMesh) {
      carrierMesh.geometry.dispose();
      const materials = Array.isArray(carrierMesh.material) ? carrierMesh.material : [carrierMesh.material];
      materials.forEach((material) => material.dispose());
    }
    disposeWoodenModel(model);
  }
}

function buildAnimationClip(
  clip: ComparisonClip,
  model: WoodenModel,
  {
    skinnedMeshName,
    yOffset,
    fps,
    rootRestPosition
  }: {
    skinnedMeshName: string;
    yOffset: number;
    fps: number;
    rootRestPosition: THREE.Vector3;
  }
): THREE.AnimationClip {
  const times = clip.frames.map((_, index) => index / fps);
  const tracks: THREE.KeyframeTrack[] = [];
  const translationValues: number[] = [];
  const boneQuaternionValues = model.bones.map(() => [] as number[]);

  for (const frame of clip.frames) {
    const actor = actorForFrame(frame);
    const [x, y, z] = rootTranslation(actor);
    translationValues.push(rootRestPosition.x + x, rootRestPosition.y + y + yOffset, rootRestPosition.z + z);

    model.bones.forEach((_, boneIndex) => {
      const quaternion = quaternionForBone(actor, boneIndex);
      boneQuaternionValues[boneIndex].push(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    });
  }

  const rootPositionTrack = boneTrackName(skinnedMeshName, model.bones[0], "position");
  tracks.push(new THREE.VectorKeyframeTrack(rootPositionTrack, times, translationValues));

  model.bones.forEach((bone, boneIndex) => {
    tracks.push(new THREE.QuaternionKeyframeTrack(boneTrackName(skinnedMeshName, bone, "quaternion"), times, boneQuaternionValues[boneIndex]));
  });

  return new THREE.AnimationClip("HYMotion_Animation", -1, tracks);
}

function applyRestPose(model: WoodenModel, actor: MotionActorFrame | null, yOffset: number, rootRestPosition: THREE.Vector3): void {
  const [x, y, z] = rootTranslation(actor);
  model.mesh.position.set(0, 0, 0);
  model.bones[0].position.set(rootRestPosition.x + x, rootRestPosition.y + y + yOffset, rootRestPosition.z + z);
  model.bones.forEach((bone) => {
    bone.quaternion.identity();
  });
}

function createSkeletonCarrierMesh(model: WoodenModel): THREE.SkinnedMesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0.001, 0, 0, 0, 0.001, 0]), 3)
  );
  geometry.setIndex([0, 1, 2]);
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    color: 0xffffff
  });
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.add(model.bones[0]);
  mesh.bind(model.mesh.skeleton, model.mesh.bindMatrix.clone());
  return mesh;
}

function boneTrackName(skinnedMeshName: string, bone: THREE.Bone, property: "position" | "quaternion"): string {
  return `${skinnedMeshName}.bones[${bone.name}].${property}`;
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
