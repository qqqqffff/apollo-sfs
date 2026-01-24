import React, { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useDropzone } from 'react-dropzone';
import FilePreview from '../../components/FilePreview';
import { useAuth } from '../../auth';
import { useFiles, useUploadFile, useDeleteFile, useFileUrl } from '../../services/fileService';
import { useQuota } from '../../services/userService';

export const Route = createFileRoute('/_auth/files/')({
  component: FilesComponent,
});

function FilesComponent() {
  const { token } = useAuth();
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);

  const { data: quota } = useQuota(token!);
  const { data: fileList, isLoading } = useFiles(token!);
  const uploadMutation = useUploadFile(token!);
  const deleteMutation = useDeleteFile(token!);

  const onDrop = (acceptedFiles: File[]) => {
    setFiles(acceptedFiles);
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop });

  const handleUpload = async () => {
    setUploading(true);
    for (const file of files) {
      await uploadMutation.mutateAsync(file);
    }
    setFiles([]);
    setUploading(false);
  };

  const handleDelete = (fileId: string) => {
    deleteMutation.mutate(fileId);
  };

  const getFileUrl = (fileId: string) => {
    return useFileUrl(fileId);
  };

  return (
    <div className="p-4">
      <h1 className="text-2xl mb-4">File Manager</h1>
      {quota && (
        <div className="mb-4">
          <p>Quota: {(quota.used / 1024 / 1024 / 1024).toFixed(2)} GB / {(quota.quota / 1024 / 1024 / 1024).toFixed(2)} GB</p>
          <progress value={quota.used / quota.quota} className="w-full" />
        </div>
      )}
      <div
        {...getRootProps()}
        className={`border-2 border-dashed p-8 text-center cursor-pointer ${
          isDragActive ? 'border-blue-500' : 'border-gray-300'
        }`}
      >
        <input {...getInputProps()} />
        {isDragActive ? (
          <p>Drop the files here ...</p>
        ) : (
          <p>Drag 'n' drop some files here, or click to select files</p>
        )}
      </div>
      {files.length > 0 && (
        <div className="mb-4">
          <h2>Selected Files:</h2>
          <ul>
            {files.map((file, index) => (
              <li key={index}>{file.name}</li>
            ))}
          </ul>
          <button
            onClick={handleUpload}
            disabled={uploading}
            className="mt-2 bg-blue-500 text-white px-4 py-2 rounded"
          >
            {uploading ? 'Uploading...' : 'Upload'}
          </button>
        </div>
      )}
      <div className="mt-8">
        <h2 className="text-xl mb-4">Uploaded Files</h2>
        {isLoading ? (
          <p>Loading...</p>
        ) : (
          fileList?.files?.map((file: any, index: number) => (
            <div key={index} className="mb-4 border p-4 rounded">
              <p>{file.name}</p>
              <FilePreview
                fileUrl={getFileUrl(file.id)}
                contentType={file.contentType}
                fileName={file.name}
              />
              <button
                onClick={() => handleDelete(file.id)}
                className="mt-2 bg-red-500 text-white px-4 py-2 rounded"
              >
                Delete
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}