import { useEffect, useRef, useState } from 'react';

import { Alert, Button, Group, Stack, Text } from '@mantine/core';

type Props = {
  titulo: string;
  onFoto: (foto: Blob) => void;
  onCancelar: () => void;
};

/**
 * Captura primária por getUserMedia sob HTTPS (capture="environment" é só hint no
 * Android 14/15 — arquitetura §6); sem permissão/câmera cai para <input capture>.
 * Overlay de tela cheia com botão gigante — luvas e sol (imutável 9).
 */
export function CameraCapture({ titulo, onFoto, onCancelar }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [semCamera, setSemCamera] = useState(false);

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setSemCamera(true);
      return;
    }
    let ativo = true;
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        if (!ativo) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          void videoRef.current.play().catch(() => setSemCamera(true));
        }
      })
      .catch(() => setSemCamera(true));
    return () => {
      ativo = false;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  function disparar() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    // qualidade alta aqui — a compressão oficial (q0.8/1920px) acontece no enviarFoto
    canvas.toBlob((blob) => blob && onFoto(blob), 'image/jpeg', 0.92);
  }

  return (
    <Stack
      gap="sm"
      p="md"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: '#111', color: '#fff' }}
    >
      <Group justify="space-between">
        <Text fw={800} size="lg" c="#fff">
          {titulo}
        </Text>
        <Button variant="default" onClick={onCancelar}>
          Cancelar
        </Button>
      </Group>

      <Alert color="yellow" p="xs">
        Fotografe o equipamento — evite colegas na imagem.
      </Alert>

      {!semCamera ? (
        <>
          <video
            ref={videoRef}
            playsInline
            muted
            style={{ flex: 1, minHeight: 0, width: '100%', objectFit: 'contain' }}
          />
          <Button size="xl" style={{ height: 72 }} fw={800} onClick={disparar}>
            📷 TIRAR A FOTO
          </Button>
        </>
      ) : (
        <Stack justify="center" style={{ flex: 1 }}>
          <Text ta="center" c="#fff">
            Sem acesso à câmera pelo navegador — use a câmera do aparelho.
          </Text>
          <Button size="xl" style={{ height: 72 }} fw={800} onClick={() => inputRef.current?.click()}>
            📷 ABRIR A CÂMERA
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              if (file) onFoto(file);
            }}
          />
        </Stack>
      )}
    </Stack>
  );
}
