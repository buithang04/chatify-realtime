package storage

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

const MaxUploadBytes int64 = 25 * 1024 * 1024

type UploadRequest struct {
	RoomID      string
	UserID      string
	ObjectKey   string
	ContentType string
	SizeBytes   int64
}

type PresignedUpload struct {
	URL       string            `json:"url"`
	Fields    map[string]string `json:"fields"`
	ObjectKey string            `json:"objectKey"`
	ExpiresAt time.Time         `json:"expiresAt"`
	MaxBytes  int64             `json:"maxBytes"`
}

type PresignedDownload struct {
	URL       string    `json:"url"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type Service struct {
	client       *minio.Client
	publicClient *minio.Client
	publicBase   *url.URL
	bucket       string
	operations   atomic.Uint64
	errors       atomic.Uint64
}

type Stats struct {
	Operations uint64
	Errors     uint64
}

func New(endpoint, publicEndpoint, accessKey, secretKey, bucket string) (*Service, error) {
	endpoint = strings.TrimSpace(endpoint)
	publicEndpoint = strings.TrimSpace(publicEndpoint)
	if endpoint == "" || publicEndpoint == "" || accessKey == "" || secretKey == "" || bucket == "" {
		return nil, fmt.Errorf("object storage configuration is incomplete")
	}
	client, err := minio.New(endpoint, &minio.Options{Creds: credentials.NewStaticV4(accessKey, secretKey, ""), Secure: strings.HasPrefix(endpoint, "https://")})
	if err != nil {
		return nil, err
	}
	base, err := url.Parse(strings.TrimRight(publicEndpoint, "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, fmt.Errorf("invalid public object storage endpoint")
	}
	publicClient, err := minio.New(base.Host, &minio.Options{Creds: credentials.NewStaticV4(accessKey, secretKey, ""), Secure: base.Scheme == "https", Region: "us-east-1"})
	if err != nil {
		return nil, err
	}
	return &Service{client: client, publicClient: publicClient, publicBase: base, bucket: bucket}, nil
}

func (s *Service) EnsureBucket(ctx context.Context) error {
	s.operations.Add(1)
	exists, err := s.client.BucketExists(ctx, s.bucket)
	if err != nil {
		s.errors.Add(1)
		return err
	}
	if !exists {
		if err := s.client.MakeBucket(ctx, s.bucket, minio.MakeBucketOptions{Region: "us-east-1"}); err != nil {
			s.errors.Add(1)
			return err
		}
	}
	return nil
}

func (s *Service) PresignUpload(ctx context.Context, input UploadRequest) (PresignedUpload, error) {
	s.operations.Add(1)
	if input.RoomID == "" || input.UserID == "" || input.ContentType == "" || input.SizeBytes < 1 || input.SizeBytes > MaxUploadBytes {
		s.errors.Add(1)
		return PresignedUpload{}, fmt.Errorf("invalid upload request")
	}
	objectKey := input.ObjectKey
	if objectKey == "" {
		objectKey = fmt.Sprintf("rooms/%s/users/%s/%s", input.RoomID, input.UserID, uuid.NewString())
	}
	policy := minio.NewPostPolicy()
	expiresAt := time.Now().UTC().Add(10 * time.Minute)
	if err := policy.SetBucket(s.bucket); err != nil {
		s.errors.Add(1)
		return PresignedUpload{}, err
	}
	if err := policy.SetKey(objectKey); err != nil {
		s.errors.Add(1)
		return PresignedUpload{}, err
	}
	if err := policy.SetExpires(expiresAt); err != nil {
		s.errors.Add(1)
		return PresignedUpload{}, err
	}
	if err := policy.SetContentType(input.ContentType); err != nil {
		s.errors.Add(1)
		return PresignedUpload{}, err
	}
	if err := policy.SetContentLengthRange(input.SizeBytes, input.SizeBytes); err != nil {
		s.errors.Add(1)
		return PresignedUpload{}, err
	}
	postURL, fields, err := s.client.PresignedPostPolicy(ctx, policy)
	if err != nil {
		s.errors.Add(1)
		return PresignedUpload{}, err
	}
	postURL = s.publicURL(postURL)
	return PresignedUpload{URL: postURL.String(), Fields: fields, ObjectKey: objectKey, ExpiresAt: expiresAt, MaxBytes: input.SizeBytes}, nil
}

func (s *Service) PresignDownload(ctx context.Context, objectKey string) (PresignedDownload, error) {
	s.operations.Add(1)
	if strings.TrimSpace(objectKey) == "" {
		s.errors.Add(1)
		return PresignedDownload{}, fmt.Errorf("object key is required")
	}
	expiresAt := time.Now().UTC().Add(10 * time.Minute)
	objectURL, err := s.publicClient.PresignedGetObject(ctx, s.bucket, objectKey, 10*time.Minute, nil)
	if err != nil {
		s.errors.Add(1)
		return PresignedDownload{}, err
	}
	return PresignedDownload{URL: objectURL.String(), ExpiresAt: expiresAt}, nil
}

func (s *Service) publicURL(objectURL *url.URL) *url.URL {
	objectURL.Scheme = s.publicBase.Scheme
	objectURL.Host = s.publicBase.Host
	if s.publicBase.Path != "" && s.publicBase.Path != "/" {
		objectURL.Path = strings.TrimRight(s.publicBase.Path, "/") + objectURL.Path
	}
	return objectURL
}

func (s *Service) StatObject(ctx context.Context, objectKey string) (int64, string, error) {
	s.operations.Add(1)
	info, err := s.client.StatObject(ctx, s.bucket, objectKey, minio.StatObjectOptions{})
	if err != nil {
		s.errors.Add(1)
		return 0, "", err
	}
	return info.Size, info.ContentType, nil
}

func (s *Service) DeleteObject(ctx context.Context, objectKey string) error {
	s.operations.Add(1)
	err := s.client.RemoveObject(ctx, s.bucket, objectKey, minio.RemoveObjectOptions{})
	if err != nil {
		s.errors.Add(1)
	}
	return err
}

func (s *Service) StorageStats() Stats {
	if s == nil {
		return Stats{}
	}
	return Stats{Operations: s.operations.Load(), Errors: s.errors.Load()}
}
