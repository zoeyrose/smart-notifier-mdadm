.PHONY: test test-python test-release packages clean

test: test-python test-release

test-python:
	python3 -m unittest discover -s tests -v

test-release:
	npm test

packages:
	./scripts/build-packages.sh

clean:
	rm -rf -- build dist
