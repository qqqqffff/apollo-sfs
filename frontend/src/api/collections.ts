import { del, patch, post } from './client'

// copyToCollection adds a pointer placing a file into a subcollection without
// moving its physical home (the file still appears in its parent collection).
export function copyToCollection(collectionId: string, fileId: string) {
  return post<{ message: string }>(`/collections/${collectionId}/items/${fileId}`)
}

// moveCollectionItem repoints a file from one subcollection to another.
export function moveCollectionItem(collectionId: string, fileId: string, targetCollectionId: string) {
  return patch<{ message: string }>(
    `/collections/${collectionId}/items/${fileId}/move`,
    { target_collection_id: targetCollectionId },
  )
}

// removeFromCollection deletes a pointer. The file's physical home is unaffected.
export function removeFromCollection(collectionId: string, fileId: string) {
  return del<{ message: string }>(`/collections/${collectionId}/items/${fileId}`)
}
