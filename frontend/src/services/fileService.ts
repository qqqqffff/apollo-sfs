import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const API_BASE = '/api/v1';

export const useFiles = (token: string) => {
  return useQuery({
    queryKey: ['files'],
    queryFn: () => fetch(`${API_BASE}/files`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(res => res.json()),
  });
};

export const useUploadFile = (token: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${API_BASE}/files/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['quota'] });
    },
  });
};

export const useDeleteFile = (token: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) => fetch(`${API_BASE}/files/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['quota'] });
    },
  });
};

export const useFileUrl = (fileId: string) => {
  return `${API_BASE}/files/${fileId}`;
};