from __future__ import annotations

import json
import socket
import time
from typing import Any, Dict, List, Optional

import pytest

from python.tcp_server import TcpBroadcastServer, TcpControlServer, TcpTelemetryServer

from .conftest import find_free_port, recv_json_lines, wait_for


# ---------------------------------------------------------------------------
# TcpTelemetryServer
# ---------------------------------------------------------------------------


class TestTcpTelemetryServer:
    def test_start_stop(self):
        server = TcpTelemetryServer(port=find_free_port())
        server.start()
        assert server.is_running()
        server.stop()
        assert not server.is_running()

    def test_broadcast_to_single_client(self):
        port = find_free_port()
        server = TcpTelemetryServer(port=port)
        server.start()
        try:
            client = socket.create_connection(("127.0.0.1", port), timeout=2.0)
            client.settimeout(0.5)
            try:
                server.enqueue_frame({"parsed": {"value": 1}})
                lines = recv_json_lines(client, expected=1, timeout=2.0)
                assert len(lines) == 1
                assert lines[0]["parsed"]["value"] == 1
            finally:
                client.close()
        finally:
            server.stop()

    def test_broadcast_to_multiple_clients(self):
        port = find_free_port()
        server = TcpTelemetryServer(port=port)
        server.start()
        try:
            clients = []
            for _ in range(3):
                c = socket.create_connection(("127.0.0.1", port), timeout=2.0)
                c.settimeout(0.5)
                clients.append(c)

            time.sleep(0.1)  # allow accept
            server.enqueue_frame({"parsed": {"value": 42}})

            for c in clients:
                lines = recv_json_lines(c, expected=1, timeout=2.0)
                assert len(lines) == 1
                assert lines[0]["parsed"]["value"] == 42
        finally:
            for c in clients:
                c.close()
            server.stop()

    def test_client_count(self):
        port = find_free_port()
        server = TcpTelemetryServer(port=port)
        server.start()
        try:
            assert server.get_client_count() == 0
            c1 = socket.create_connection(("127.0.0.1", port), timeout=2.0)
            c2 = socket.create_connection(("127.0.0.1", port), timeout=2.0)
            assert wait_for(lambda: server.get_client_count() == 2)
            c1.close()
            assert wait_for(lambda: server.get_client_count() == 1)
            c2.close()
            assert wait_for(lambda: server.get_client_count() == 0)
        finally:
            server.stop()

    def test_ignores_client_writes(self):
        """Telemetry server should not crash when clients send data."""
        port = find_free_port()
        server = TcpTelemetryServer(port=port)
        server.start()
        try:
            client = socket.create_connection(("127.0.0.1", port), timeout=2.0)
            client.settimeout(0.5)
            try:
                client.sendall(b'{"cmd":"test"}\n')
                time.sleep(0.1)
                # Server should still be running.
                assert server.is_running()
            finally:
                client.close()
        finally:
            server.stop()

    def test_bound_port(self):
        server = TcpTelemetryServer(port=0)
        server.start()
        try:
            assert server.bound_port > 0
            assert server.bound_host == "127.0.0.1"
        finally:
            server.stop()


# ---------------------------------------------------------------------------
# TcpControlServer
# ---------------------------------------------------------------------------


class TestTcpControlServer:
    def test_start_stop(self):
        server = TcpControlServer(port=find_free_port())
        server.start()
        assert server.is_running()
        server.stop()
        assert not server.is_running()

    def test_forwards_command(self):
        received: List[Dict[str, Any]] = []
        port = find_free_port()
        server = TcpControlServer(port=port, command_handler=received.append)
        server.start()
        try:
            client = socket.create_connection(("127.0.0.1", port), timeout=2.0)
            try:
                client.sendall(b'{"motor_pwm":100}\n')
                assert wait_for(lambda: len(received) == 1)
                assert received[0]["motor_pwm"] == 100
            finally:
                client.close()
        finally:
            server.stop()

    def test_does_not_broadcast(self):
        """Control server should not broadcast frames."""
        port = find_free_port()
        server = TcpControlServer(port=port)
        server.start()
        try:
            client = socket.create_connection(("127.0.0.1", port), timeout=2.0)
            client.settimeout(0.3)
            try:
                # enqueue_frame is a no-op on control server
                server.enqueue_frame({"data": "test"})
                time.sleep(0.2)
                try:
                    data = client.recv(4096)
                except socket.timeout:
                    data = b""
                assert data == b""
            finally:
                client.close()
        finally:
            server.stop()

    def test_forwards_invalid_json_as_raw_line(self):
        received: List[Dict[str, Any]] = []
        port = find_free_port()
        server = TcpControlServer(port=port, command_handler=received.append)
        server.start()
        try:
            client = socket.create_connection(("127.0.0.1", port), timeout=2.0)
            try:
                client.sendall(b"not-json\n")
                assert wait_for(lambda: len(received) == 1)
                assert received[0]["cmd"] == "raw_line"
                assert received[0]["line"] == "not-json"
            finally:
                client.close()
        finally:
            server.stop()

    def test_forwards_non_dict_json_as_raw_line(self):
        received: List[Dict[str, Any]] = []
        port = find_free_port()
        server = TcpControlServer(port=port, command_handler=received.append)
        server.start()
        try:
            client = socket.create_connection(("127.0.0.1", port), timeout=2.0)
            try:
                client.sendall(b'[1,2,3]\n')
                assert wait_for(lambda: len(received) == 1)
                assert received[0]["cmd"] == "raw_line"
                assert received[0]["line"] == "[1,2,3]"
            finally:
                client.close()
        finally:
            server.stop()

    def test_forwards_numeric_scalar_as_raw_line(self):
        received: List[Dict[str, Any]] = []
        port = find_free_port()
        server = TcpControlServer(port=port, command_handler=received.append)
        server.start()
        try:
            client = socket.create_connection(("127.0.0.1", port), timeout=2.0)
            try:
                client.sendall(b"90\n")
                assert wait_for(lambda: len(received) == 1)
                assert received[0]["cmd"] == "raw_line"
                assert received[0]["line"] == "90"
            finally:
                client.close()
        finally:
            server.stop()


# ---------------------------------------------------------------------------
# TcpBroadcastServer (combined mode)
# ---------------------------------------------------------------------------


class TestTcpBroadcastServer:
    def test_combined_broadcast_and_command(self):
        received: List[Dict[str, Any]] = []
        port = find_free_port()
        server = TcpBroadcastServer(port=port, command_handler=received.append)
        server.start()
        try:
            client = socket.create_connection(("127.0.0.1", port), timeout=2.0)
            client.settimeout(0.5)
            try:
                # Broadcast
                server.enqueue_frame({"value": 1})
                lines = recv_json_lines(client, expected=1, timeout=2.0)
                assert len(lines) == 1
                assert lines[0]["value"] == 1

                # Command
                client.sendall(b'{"motor_pwm":50}\n')
                assert wait_for(lambda: len(received) == 1)
                assert received[0]["motor_pwm"] == 50
            finally:
                client.close()
        finally:
            server.stop()

    def test_double_start_is_idempotent(self):
        port = find_free_port()
        server = TcpBroadcastServer(port=port)
        server.start()
        try:
            server.start()  # second start should be no-op
            assert server.is_running()
        finally:
            server.stop()

    def test_double_stop_is_safe(self):
        port = find_free_port()
        server = TcpBroadcastServer(port=port)
        server.start()
        server.stop()
        server.stop()  # second stop should not raise
        assert not server.is_running()
