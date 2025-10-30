FROM golang:1.25.3-alpine AS builder

RUN apk add --no-cache git

WORKDIR /app

COPY ./backend/go.mod ./

COPY ./backend/go.sum ./

RUN go mod download

COPY *.go ./

RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o main .

FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /root/

COPY --from=builder /app/main .

EXPOSE 8080

CMD ["./main"]