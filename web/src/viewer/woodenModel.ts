import * as THREE from "three";

const NUM_SKIN_WEIGHTS = 4;

const DEFAULT_EDGES = [
  -1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19, 20, 22, 23, 20, 25,
  26, 20, 28, 29, 20, 31, 32, 20, 34, 35, 21, 37, 38, 21, 40, 41, 21, 43, 44, 21, 46, 47, 21,
  49, 50
];

const SMPLH_JOINT_NAMES = [
  "Pelvis",
  "L_Hip",
  "R_Hip",
  "Spine1",
  "L_Knee",
  "R_Knee",
  "Spine2",
  "L_Ankle",
  "R_Ankle",
  "Spine3",
  "L_Foot",
  "R_Foot",
  "Neck",
  "L_Collar",
  "R_Collar",
  "Head",
  "L_Shoulder",
  "R_Shoulder",
  "L_Elbow",
  "R_Elbow",
  "L_Wrist",
  "R_Wrist",
  "L_Index1",
  "L_Index2",
  "L_Index3",
  "L_Middle1",
  "L_Middle2",
  "L_Middle3",
  "L_Pinky1",
  "L_Pinky2",
  "L_Pinky3",
  "L_Ring1",
  "L_Ring2",
  "L_Ring3",
  "L_Thumb1",
  "L_Thumb2",
  "L_Thumb3",
  "R_Index1",
  "R_Index2",
  "R_Index3",
  "R_Middle1",
  "R_Middle2",
  "R_Middle3",
  "R_Pinky1",
  "R_Pinky2",
  "R_Pinky3",
  "R_Ring1",
  "R_Ring2",
  "R_Ring3",
  "R_Thumb1",
  "R_Thumb2",
  "R_Thumb3"
];

export interface WoodenModel {
  mesh: THREE.SkinnedMesh;
  bones: THREE.Bone[];
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}`);
  }
  return response.arrayBuffer();
}

async function fetchJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const response = await fetch(url);
    return response.ok ? ((await response.json()) as T) : fallback;
  } catch {
    return fallback;
  }
}

function bindBones(keypoints: Float32Array, edges: number[], jointNames: string[]): THREE.Bone[] {
  const rootBone = new THREE.Bone();
  rootBone.position.set(keypoints[0], keypoints[1], keypoints[2]);
  rootBone.name = jointNames[0] ?? "Pelvis";
  const bones = [rootBone];
  const jointCount = keypoints.length / 3;

  while (edges.length < jointCount) {
    edges.push(0);
  }

  for (let index = 1; index < jointCount; index += 1) {
    const bone = new THREE.Bone();
    const parentIndex = edges[index];
    bone.name = jointNames[index] ?? `Joint_${index}`;

    if (parentIndex >= 0 && parentIndex < index) {
      bone.position.set(
        keypoints[3 * index] - keypoints[3 * parentIndex],
        keypoints[3 * index + 1] - keypoints[3 * parentIndex + 1],
        keypoints[3 * index + 2] - keypoints[3 * parentIndex + 2]
      );
      bones[parentIndex].add(bone);
    } else {
      bone.position.set(0, 0, 0);
      bones[0].add(bone);
    }
    bones.push(bone);
  }

  return bones;
}

export async function loadWoodenModel(basePath = "/assets/dump_wooden"): Promise<WoodenModel> {
  const [vTemplateBuffer, facesBuffer, skinWeightsBuffer, skinIndicesBuffer, keypointsBuffer, uvsBuffer] =
    await Promise.all([
      fetchBuffer(`${basePath}/v_template.bin`),
      fetchBuffer(`${basePath}/faces.bin`),
      fetchBuffer(`${basePath}/skinWeights.bin`),
      fetchBuffer(`${basePath}/skinIndice.bin`),
      fetchBuffer(`${basePath}/j_template.bin`),
      fetchBuffer(`${basePath}/uvs.bin`)
    ]);

  const kintree = await fetchBuffer(`${basePath}/kintree.bin`)
    .then((buffer) => Array.from(new Int32Array(buffer)))
    .catch(() => [...DEFAULT_EDGES]);
  const jointNames = await fetchJson<string[]>(`${basePath}/joint_names.json`, [...SMPLH_JOINT_NAMES]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vTemplateBuffer), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(facesBuffer), 1));
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(new Uint16Array(skinIndicesBuffer), NUM_SKIN_WEIGHTS));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(new Float32Array(skinWeightsBuffer), NUM_SKIN_WEIGHTS));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvsBuffer), 2));
  geometry.computeVertexNormals();

  const bones = bindBones(new Float32Array(keypointsBuffer), kintree, jointNames);
  const skeleton = new THREE.Skeleton(bones);
  const texture = await new THREE.TextureLoader().loadAsync(`${basePath}/Boy_lambert4_BaseColor.webp`);
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.62,
    metalness: 0.18,
    envMapIntensity: 1.3
  });

  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.add(bones[0]);
  mesh.bind(skeleton);

  return { mesh, bones };
}

export function disposeWoodenModel(model: WoodenModel): void {
  model.mesh.geometry.dispose();
  const materials = Array.isArray(model.mesh.material) ? model.mesh.material : [model.mesh.material];
  materials.forEach((material) => {
    const map = material instanceof THREE.MeshStandardMaterial ? material.map : null;
    map?.dispose();
    material.dispose();
  });
}
