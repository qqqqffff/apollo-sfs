import React from 'react';

interface FilePreviewProps {
  fileUrl: string;
  contentType: string;
  fileName: string;
}

const FilePreview: React.FC<FilePreviewProps> = ({ fileUrl, contentType, fileName }) => {
  const isPreviewable = contentType.startsWith('image/') || contentType === 'application/pdf';

  if (!isPreviewable) {
    return <p>Preview not available for this file type.</p>;
  }

  if (contentType.startsWith('image/')) {
    return <img src={fileUrl} alt={fileName} style={{ maxWidth: '100%', maxHeight: '500px' }} />;
  }

  if (contentType === 'application/pdf') {
    return <iframe src={fileUrl} width="100%" height="500px" title={fileName} />;
  }

  return null;
};

export default FilePreview;